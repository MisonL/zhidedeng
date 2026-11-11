import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, openStore } from '../server/src/node-app.ts';
import { feishuHostnameKey } from '@zhidedeng/shared';
import { hostnameOf, stationSchema } from '../server/src/submissions.ts';

/**
 * 把存量飞书站点补成 approved 的投稿记录。
 *
 * 上线前的库里，飞书同步是直接写 entities 的，没有 submissions 行。
 * 切到队列模式后这些站点会变得「删不掉」：
 * removeStation 要拿 expectedSubmissionId 去比对「该 hostname 最新的 approved upsert」，
 * 没有投稿行就永远比对失败，接口一直回 STALE_REMOVAL；
 * submissionState 也只列有 approved 投稿的 hostname，连该传什么 id 都查不到。
 *
 * 所以这一步是上线前的一次性回填。默认只打印不写库，加 --apply 才真写。
 */

interface BackfillPlan {
  slug: string;
  hostname: string;
  originKey: string;
  submissionId: string;
  payload: Record<string, unknown>;
}

interface Skipped {
  slug: string;
  reason: string;
}

export interface BackfillResult {
  planned: BackfillPlan[];
  skipped: Skipped[];
  applied: number;
}

export function planBackfill(store: ReturnType<typeof openStore>): BackfillResult {
  // 已有的 approved upsert 覆盖了哪些 hostname。按 reviewedAt 取最新，
  // 与 removeStation 的判定口径保持一致。
  const approved = store.db
    .prepare("SELECT id, originKey FROM submissions WHERE kind = 'station' AND action = 'upsert' AND status = 'approved' ORDER BY reviewedAt DESC, rowid DESC")
    .all();
  const covered = new Set(approved.map(row => feishuHostnameKey(row.originKey as string)));

  const offersByStation = new Map<string, { modelSlug: string; rate: number }[]>();
  for (const offer of store.db.prepare('SELECT stationSlug, modelSlug, rate FROM offers ORDER BY stationSlug, modelSlug').all()) {
    const list = offersByStation.get(offer.stationSlug as string) ?? [];
    list.push({ modelSlug: offer.modelSlug as string, rate: offer.rate as number });
    offersByStation.set(offer.stationSlug as string, list);
  }

  const planned: BackfillPlan[] = [];
  const skipped: Skipped[] = [];
  for (const station of store.all('station')) {
    // 只处理飞书来源。agent / demo / user 的站点各有自己的来路，不该被这条脚本碰。
    if (station.source !== 'submission') continue;
    const hostname = hostnameOf(station.url);
    if (hostname === null) {
      skipped.push({ slug: station.slug, reason: 'URL 解析不出 hostname' });
      continue;
    }
    const key = feishuHostnameKey(hostname);
    if (covered.has(key)) continue;

    // payload 必须能过审核时用的 schema，否则回填出来也审不动。
    const payload = {
      name: station.name,
      description: station.description,
      url: station.url,
      rechargeThreshold: station.rechargeThreshold ?? null,
      paymentMethods: station.paymentMethods ?? [],
      offers: offersByStation.get(station.slug) ?? [],
    };
    const parsed = stationSchema.safeParse(payload);
    if (!parsed.success) {
      // 与 submissionState 的处理一致：单条坏数据只跳过并告警，不让整条脚本停摆。
      skipped.push({ slug: station.slug, reason: `payload 不符合当前 schema：${parsed.error.issues[0]?.message ?? '未知原因'}` });
      continue;
    }
    planned.push({ slug: station.slug, hostname, originKey: key, submissionId: randomUUID(), payload: parsed.data as unknown as Record<string, unknown> });
  }
  return { planned, skipped, applied: 0 };
}

export function applyBackfill(store: ReturnType<typeof openStore>, planned: BackfillPlan[], now = new Date()): number {
  const reviewedAt = now.toISOString();
  return store.transaction(() => {
    let written = 0;
    for (const item of planned) {
      // 再查一次：回填可能与正在跑的同步撞上，事务内确认没人先写过这个 hostname。
      const existing = store.db
        .prepare("SELECT originKey FROM submissions WHERE kind = 'station' AND action = 'upsert' AND status = 'approved'")
        .all()
        .some(row => feishuHostnameKey(row.originKey as string) === item.originKey);
      if (existing) continue;

      const serialized = JSON.stringify(item.payload);
      const payloadHash = createHash('sha256').update(serialized).digest('hex');
      store.db.prepare(
        'INSERT INTO submissions (id, kind, channel, originKey, batchId, action, autoApproved, payload, payloadHash, actorHandle, ip, status, reason, reviewedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        item.submissionId, 'station', 'feishu', item.originKey, null, 'upsert', 0, serialized, payloadHash,
        null, '127.0.0.1', 'approved', `回填：存量站点 ${item.slug} 此前只有实体没有投稿记录`, reviewedAt, reviewedAt,
      );
      written += 1;
    }
    return written;
  });
}

/** 命令行入口：默认 dry-run，--apply 才写库。 */
export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const dbPath = argv.find(arg => arg.startsWith('--db='))?.slice(5) ?? process.env.DB_PATH;
  if (!dbPath) throw new Error('需要 --db=<路径> 或环境变量 DB_PATH');
  const db = openDatabase(dbPath);
  try {
    const store = openStore(db);
    const result = planBackfill(store);
    console.log(`存量飞书站点：待回填 ${result.planned.length} 条，跳过 ${result.skipped.length} 条`);
    for (const item of result.planned) console.log(`  + ${item.slug}  ${item.originKey}`);
    for (const item of result.skipped) console.log(`  ! ${item.slug}  跳过：${item.reason}`);
    if (!apply) {
      console.log('\n当前是 dry-run，没有写库。确认无误后加 --apply 执行。');
      return 0;
    }
    const written = applyBackfill(store, result.planned);
    console.log(`\n已写入 ${written} 条 approved 投稿记录。`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

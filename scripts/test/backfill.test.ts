import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationRecord } from '../../server/src/database.ts';
import { openDatabase, openStore } from '../../server/src/node-app.ts';
import { removeStation, submissionState } from '../../server/src/submissions.ts';
import { applyBackfill, planBackfill } from '../backfill-submissions.ts';

const clock = () => new Date('2026-11-11T00:00:00Z');
let db: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof openStore>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = openDatabase(':memory:');
  store = openStore(db);
});

/** 直接写实体，模拟老版本飞书同步的行为：只有 entities，没有 submissions 行。 */
function putStation(slug: string, hostname: string, source: StationRecord['source'] = 'submission', patch: Partial<StationRecord> = {}) {
  const record: StationRecord = {
    slug, name: `存量 ${slug}`, description: '老数据', url: `https://${hostname}/`,
    rechargeThreshold: null, paymentMethods: [], source,
    uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    ...patch,
  };
  store.put('station', slug, record);
}
const legacy = (slug: string, hostname: string, patch: Partial<StationRecord> = {}) => putStation(slug, hostname, 'submission', patch);

describe('存量站点回填', () => {
  it('没有投稿记录的存量站会变得删不掉，回填后可以', () => {
    legacy('legacy-a', 'a.example.com');
    // 回填前：同步脚本根本看不到它，下架也无从下手。
    expect(submissionState(store).stations).toEqual([]);
    expect(() => removeStation(store, 'legacy-a', 'whatever', clock().toISOString()))
      .toThrow(expect.objectContaining({ code: 'STALE_REMOVAL' }));

    const plan = planBackfill(store);
    expect(plan.planned).toHaveLength(1);
    expect(applyBackfill(store, plan.planned, clock())).toBe(1);

    const state = submissionState(store);
    expect(state.stations).toHaveLength(1);
    // 回填后拿得到 submissionId，下架判定能过。
    expect(() => removeStation(store, 'legacy-a', state.stations[0]!.submissionId, clock().toISOString())).not.toThrow();
  });

  it('回填保留下报价的计价口径与来源时间', () => {
    // 回填的 payload 会被写成一条 station upsert 投稿，审核时再物化回 offers。
    // 原先把 offers 从库里读出来时只抄了 modelSlug/rate——口径和报价时间在这一步
    // 蒸发，回填后所有报价都变回「综合、时间未知」，等于把来源给的信息抹掉。
    putStation('legacy-basis', 'basis.example.com');
    store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate, basis, quotedAt) VALUES (?,?,?,?,?)')
      .run('legacy-basis', 'gpt-4-1', 0.42, 'input', '2026-10-01T00:00:00.000Z');
    store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate, basis) VALUES (?,?,?,?)')
      .run('legacy-basis', 'o3', 0.9, 'blended');

    const plan = planBackfill(store);
    expect(plan.planned).toHaveLength(1);
    const offers = (plan.planned[0]!.payload as { offers: { modelSlug: string; rate: number; basis?: string; quotedAt?: string | null }[] }).offers;
    expect(offers).toEqual([
      { modelSlug: 'gpt-4-1', rate: 0.42, basis: 'input', quotedAt: '2026-10-01T00:00:00.000Z' },
      { modelSlug: 'o3', rate: 0.9, basis: 'blended', quotedAt: null },
    ]);
  });

  it('www 与裸域归一到同一个 hostname，不会重复回填', () => {
    legacy('legacy-b', 'www.b.example.com');
    const plan = planBackfill(store);
    expect(plan.planned[0]!.originKey).toBe('b.example.com');
  });

  it('重复跑不产生重复行', () => {
    legacy('legacy-a', 'a.example.com');
    applyBackfill(store, planBackfill(store).planned, clock());
    const second = planBackfill(store);
    expect(second.planned).toHaveLength(0);
    expect(applyBackfill(store, second.planned, clock())).toBe(0);
    expect(store.db.prepare("SELECT count(*) AS count FROM submissions WHERE kind = 'station'").get()!.count).toBe(1);
  });

  it('只碰 source=submission 的站点', () => {
    legacy('legacy-a', 'a.example.com');
    putStation('agent-x', 'agent.example.com', 'agent');
    putStation('demo-y', 'demo.example.com', 'demo');
    expect(planBackfill(store).planned.map(item => item.slug)).toEqual(['legacy-a']);
  });

  it('payload 不合规的行只跳过并告警，不让整条脚本停摆', () => {
    legacy('legacy-a', 'a.example.com');
    // 老数据缺 name：回填出来也审不动，跳过并说明原因。
    legacy('legacy-broken', 'broken.example.com', { name: '' });
    const plan = planBackfill(store);
    expect(plan.planned.map(item => item.slug)).toEqual(['legacy-a']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.slug).toBe('legacy-broken');
    expect(plan.skipped[0]!.reason).toContain('schema');
  });

  it('回填的报价跟着站点一起带过来', () => {
    legacy('legacy-a', 'a.example.com');
    store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run('legacy-a', 'gpt-4-1', 0.8);
    const plan = planBackfill(store);
    // 老报价没有口径列，补列后读出来就是 blended；quote 时间则明确是「没说」。
    expect(plan.planned[0]!.payload.offers).toEqual([{ modelSlug: 'gpt-4-1', rate: 0.8, basis: 'blended', quotedAt: null }]);
  });
});

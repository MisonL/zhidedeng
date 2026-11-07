import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogImportRequest } from '@zhidedeng/shared';
import { createApp, openStore } from '../src/node-app.ts';
import { enqueueSubmission, reviewSubmission } from '../src/submissions.ts';

const TOKEN = 'guard-admin-token-0123456789abcdef';
const admin = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const clock = () => new Date('2026-11-07T04:00:00Z');

let server: ReturnType<typeof createApp>;
beforeEach(() => { server = createApp({ dbPath: ':memory:', now: clock, syncToken: TOKEN }); });
afterEach(() => server.db.close());

const stationPayload = {
  name: '队列站点', description: '经队列物化的站点', url: 'https://shared.example.com/',
  rechargeThreshold: 10, paymentMethods: [], offers: [{ modelSlug: 'gpt-4-1', rate: 0.5 }],
};
// 飞书同步要发布的同名 slug，内容与队列版本不同
const feishuImport = (): CatalogImportRequest => ({
  stations: [{
    slug: 'sub-shared-example-com', name: '飞书版本', description: '来自飞书表格',
    url: 'https://shared.example.com/', rechargeThreshold: 30, paymentMethods: ['微信'],
    offers: [{ modelSlug: 'gpt-4-1', rate: 0.9 }, { modelSlug: 'o3', rate: 1.2 }],
  }],
  posts: [],
});
const importCatalog = (payload: unknown) => server.app.request('/api/admin/import', {
  method: 'POST', headers: admin, body: JSON.stringify(payload),
});

describe('飞书全量导入不覆盖队列物化的站点', () => {
  const enqueueAndApprove = async (channel: 'agent' | 'feishu' = 'agent') => {
    const store = openStore(server.db);
    const { submission } = enqueueSubmission(store, {
      kind: 'station', channel, originKey: 'shared.example.com', payload: stationPayload,
      ip: '127.0.0.1', now: clock(),
    });
    reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    return store;
  };

  it('跳过已被 agent 占用的 slug，不覆盖内容也不改动它的报价', async () => {
    const store = await enqueueAndApprove('agent');
    const before = store.get('station', 'sub-shared-example-com')!;
    const beforeOffers = server.db.prepare('SELECT modelSlug, rate FROM offers WHERE stationSlug = ? ORDER BY modelSlug').all('sub-shared-example-com');

    const response = await importCatalog(feishuImport());
    expect(response.status).toBe(200);
    const result = await response.json() as { stations: number; skipped: { slug: string; reason: string }[] };
    expect(result.skipped).toEqual([{ slug: 'sub-shared-example-com', reason: '该站点已由其他通道接管' }]);
    expect(result.stations).toBe(0);

    // 站点内容没变，source 仍是 agent
    expect(store.get('station', 'sub-shared-example-com')).toEqual(before);
    expect(store.get('station', 'sub-shared-example-com')!.source).toBe('agent');
    // 报价也没有被混入飞书的版本
    expect(server.db.prepare('SELECT modelSlug, rate FROM offers WHERE stationSlug = ? ORDER BY modelSlug').all('sub-shared-example-com')).toEqual(beforeOffers);
  });

  it('feishu 渠道物化的站点仍被本接口接管，不算占用', async () => {
    await enqueueAndApprove('feishu');
    const response = await importCatalog(feishuImport());
    const result = await response.json() as { stations: number; skipped: unknown[] };
    expect(result.skipped).toEqual([]);
    expect(result.stations).toBe(1);
    expect(openStore(server.db).get('station', 'sub-shared-example-com')!.name).toBe('飞书版本');
  });

  it('被跳过的站点不影响同批次其它站点的导入', async () => {
    await enqueueAndApprove('agent');
    const payload: CatalogImportRequest = {
      stations: [
        ...feishuImport().stations,
        { slug: 'sub-other-example-com', name: '另一站', description: '不受影响', url: 'https://other.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'o3', rate: 1.1 }] },
      ],
      posts: [],
    };
    const result = await (await importCatalog(payload)).json() as { stations: number; skipped: unknown[] };
    expect(result.stations).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(openStore(server.db).get('station', 'sub-other-example-com')!.name).toBe('另一站');
  });
});

describe('复核发现的边界问题', () => {
  const enqueue = (payload: unknown, originKey: string) => enqueueSubmission(openStore(server.db), {
    kind: 'station', channel: 'agent', originKey, payload, ip: '127.0.0.1', now: clock(),
  });

  it('长 hostname 截断后不会和另一个站点共用 slug', async () => {
    const store = openStore(server.db);
    const prefix = `${'a'.repeat(63)}.${'b'.repeat(40)}`;
    const one = `${prefix}.one.example.com`;
    const two = `${prefix}.two.example.com`;
    expect(one.length).toBeLessThanOrEqual(253);

    const first = enqueue({ ...stationPayload, url: `https://${one}/`, name: '站点一' }, one);
    reviewSubmission(store, clock(), first.submission.id, { status: 'approved' });
    const second = enqueue({ ...stationPayload, url: `https://${two}/`, name: '站点二' }, two);
    reviewSubmission(store, clock(), second.submission.id, { status: 'approved' });

    const names = store.all('station').map(station => station.name).filter(name => ['站点一', '站点二'].includes(name)).sort();
    expect(names).toEqual(['站点一', '站点二']);
  });

  it('清洗后撞车的 hostname 也各自独立', async () => {
    const store = openStore(server.db);
    // a.b.com 与 a-b.com 清洗后都是 a-b-com
    const first = enqueue({ ...stationPayload, url: 'https://a.b.com/', name: '点号站' }, 'a.b.com');
    reviewSubmission(store, clock(), first.submission.id, { status: 'approved' });
    const second = enqueue({ ...stationPayload, url: 'https://a-b.com/', name: '连字符站' }, 'a-b.com');
    reviewSubmission(store, clock(), second.submission.id, { status: 'approved' });

    const names = store.all('station').map(station => station.name).filter(name => ['点号站', '连字符站'].includes(name)).sort();
    expect(names).toEqual(['点号站', '连字符站']);
  });

  it('审核已存在的模型返回 409，不静默覆盖名称和 tags', async () => {
    const store = openStore(server.db);
    const before = store.get('model', 'gpt-4-1')!;
    const { submission } = enqueueSubmission(store, {
      kind: 'model', channel: 'agent', originKey: 'gpt-4-1',
      payload: { slug: 'gpt-4-1', vendor: 'openai', name: '被改掉的名字', description: '不应生效' },
      ip: '127.0.0.1', now: clock(),
    });
    const response = await server.app.request(`/api/admin/submissions/${submission.id}/review`, {
      method: 'POST', headers: admin, body: JSON.stringify({ status: 'approved' }),
    });
    expect(response.status).toBe(409);
    expect(store.get('model', 'gpt-4-1')).toEqual(before);
  });

  it('allowNewModels 拒绝不符合 slug 规则的模型名，避免产生无法路由的条目', async () => {
    const payload = {
      allowNewModels: true,
      stations: [{
        slug: 'sub-weird-model-com', name: '怪模型站', description: '测试非法 slug',
        url: 'https://weird-model.com/', rechargeThreshold: null, paymentMethods: [],
        offers: [{ modelSlug: 'foo/bar', rate: 0.5 }],
      }],
      posts: [],
    };
    const response = await importCatalog(payload);
    expect(response.status).toBe(400);
    expect(openStore(server.db).get('model', 'foo/bar')).toBeUndefined();
  });

  it('originKey 与 url hostname 不同时，重复提交仍更新同一条记录', () => {
    const store = openStore(server.db);
    // 飞书用记录 ID 作 originKey，和站点 url 的 hostname 无关
    const submit = (name: string) => {
      const { submission } = enqueue({ ...stationPayload, name }, 'rec-feishu-1');
      reviewSubmission(store, clock(), submission.id, { status: 'approved' });
      return submission;
    };
    submit('第一次');
    submit('第二次');

    const stations = store.all('station').filter(station => station.name.startsWith('第'));
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({ slug: 'sub-shared-example-com', name: '第二次' });
  });

  it('slug 撞车时两个站点各自独立，重复提交不新增第三条', () => {
    const store = openStore(server.db);
    const submit = (url: string, name: string) => {
      const { submission } = enqueue({ ...stationPayload, url, name }, new URL(url).hostname);
      reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    };
    submit('https://a.b.com/', '点号站');
    submit('https://a-b.com/', '连字符站');
    // 两个撞车站点各再提交一次，应各自更新而非新增
    submit('https://a.b.com/', '点号站2');
    submit('https://a-b.com/', '连字符站2');

    // 只看队列物化出来的站点（slug 前缀 sub-），避开种子数据
    const mine = store.all('station').filter(station => station.slug.startsWith('sub-'));
    expect(mine).toHaveLength(2);
    expect(mine.map(station => station.name).sort()).toEqual(['点号站2', '连字符站2']);
  });
});

describe('slug 分配的极端情况（Codex 二轮反例）', () => {
  const approve = (payload: unknown, originKey: string) => {
    const store = openStore(server.db);
    const { submission } = enqueueSubmission(store, {
      kind: 'station', channel: 'agent', originKey, payload, ip: '127.0.0.1', now: clock(),
    });
    return reviewSubmission(store, clock(), submission.id, { status: 'approved' });
  };
  const byName = (name: string) => openStore(server.db).all('station').find(station => station.name === name);

  it('哈希候选已被占用时不会覆盖别人', async () => {
    await approve({ ...stationPayload, url: 'https://a.b.com/', name: '甲' }, 'a.b.com');
    // 预先占掉 「丙」 本该拿到的哈希候选，模拟 hostname 恰好撞上别人哈希的情况
    const store = openStore(server.db);
    const yiSlug = 'sub-a-b-com-3e326853e5';
    store.put('station', yiSlug, {
      ...stationPayload, slug: yiSlug, name: '乙', url: 'https://b.example.com/',
      uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, source: 'agent',
    });

    await approve({ ...stationPayload, url: 'https://a-b.com/', name: '丙' }, 'a-b.com');

    // 丙 不能覆盖 乙
    expect(store.get('station', yiSlug)!.name).toBe('乙');
    const bing = byName('丙');
    expect(bing).toBeDefined();
    expect(bing!.slug).not.toBe(yiSlug);
  });

  it('同一站点重复审批不会在两种 slug 之间横跳', async () => {
    await approve({ ...stationPayload, url: 'https://a.b.com/', name: '点号站' }, 'a.b.com');
    await approve({ ...stationPayload, url: 'https://a-b.com/', name: '连字符站' }, 'a-b.com');
    const first = byName('连字符站')!.slug;

    // 再提交两次，slug 必须稳定
    await approve({ ...stationPayload, url: 'https://a-b.com/', name: '连字符站2' }, 'a-b.com');
    await approve({ ...stationPayload, url: 'https://a-b.com/', name: '连字符站3' }, 'a-b.com');

    expect(byName('连字符站3')!.slug).toBe(first);
    // 连字符站始终只有一条记录
    expect(openStore(server.db).all('station').filter(station => station.name.startsWith('连字符站'))).toHaveLength(1);
  });

  it('base 站点被删掉后重新提交，仍沿用原来的哈希 slug', async () => {
    await approve({ ...stationPayload, url: 'https://a.b.com/', name: '点号站' }, 'a.b.com');
    await approve({ ...stationPayload, url: 'https://a-b.com/', name: '连字符站' }, 'a-b.com');
    const hashedSlug = byName('连字符站')!.slug;
    const store = openStore(server.db);

    // 删掉占着 base 的那个站点
    store.db.prepare("DELETE FROM entities WHERE kind = 'station' AND id = ?").run('sub-a-b-com');
    expect(store.get('station', 'sub-a-b-com')).toBeUndefined();

    await approve({ ...stationPayload, url: 'https://a-b.com/', name: '连字符站再来' }, 'a-b.com');
    // 不能因为 base 空出来了就搬过去，否则旧链接失效
    expect(byName('连字符站再来')!.slug).toBe(hashedSlug);
    expect(store.get('station', 'sub-a-b-com')).toBeUndefined();
  });
});

describe('模型更新接口', () => {
  const patch = (slug: string, body: unknown) => server.app.request(`/api/admin/models/${slug}`, {
    method: 'PATCH', headers: admin, body: JSON.stringify(body),
  });

  it('可以改名字和厂商，被报价引用的模型也能改', async () => {
    const store = openStore(server.db);
    const before = store.get('model', 'gpt-4-1')!;
    expect(server.db.prepare('SELECT 1 FROM offers WHERE modelSlug = ? LIMIT 1').get('gpt-4-1')).toBeDefined();

    const response = await patch('gpt-4-1', { vendor: before.vendor, name: '改名后的模型', description: '新描述' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ slug: 'gpt-4-1', name: '改名后的模型', description: '新描述' });
    // 报价引用不受影响
    expect(store.get('model', 'gpt-4-1')!.name).toBe('改名后的模型');
  });

  it('不存在的模型 404，不存在的厂商 400', async () => {
    expect((await patch('no-such-model', { vendor: 'openai', name: 'x', description: 'y' })).status).toBe(404);
    expect((await patch('gpt-4-1', { vendor: 'no-such-vendor', name: 'x', description: 'y' })).status).toBe(400);
  });

  it('保留原有 tags，不会被顺手清空', async () => {
    const store = openStore(server.db);
    const withTags = { ...store.get('model', 'gpt-4-1')!, tags: ['推理'] };
    store.put('model', 'gpt-4-1', withTags);
    await patch('gpt-4-1', { vendor: withTags.vendor, name: '改名', description: '描述' });
    expect(store.get('model', 'gpt-4-1')!.tags).toEqual(['推理']);
  });

  it('需要鉴权', async () => {
    expect((await server.app.request('/api/admin/models/gpt-4-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(401);
  });
});

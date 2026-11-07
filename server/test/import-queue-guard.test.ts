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
});

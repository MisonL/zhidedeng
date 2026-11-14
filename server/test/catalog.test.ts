import { describe, expect, it } from 'vitest';
import type { CatalogImportRequest, Post, StationDetail } from '@zhidedeng/shared';
import { buildApp } from '../src/app.ts';
import { authorizeAdmin, deleteModel, importResponse } from '../src/catalog.ts';
import { openDatabase, openStore } from '../src/node-app.ts';
import { enqueueSubmission } from '../src/submissions.ts';
import { seed } from '../src/seed.ts';

const now = () => new Date('2026-11-06T01:00:00Z');

function newStore() {
  const store = openStore(openDatabase(':memory:'));
  seed(store, new Date('2026-11-05T00:00:00Z'));
  return store;
}

const submittedOffers = (store: ReturnType<typeof newStore>) => store.db.prepare("SELECT modelSlug FROM offers WHERE stationSlug = 'sub-api-example-com'").all();

const submission: CatalogImportRequest = {
  stations: [{
    slug: 'sub-api-example-com', name: '示例站', description: '群友推荐', url: 'https://api.example.com/',
    rechargeThreshold: 10, paymentMethods: ['支付宝'], offers: [{ modelSlug: 'gpt-4-1', rate: 0.5 }, { modelSlug: 'o3', rate: 0.7 }],
  }],
  posts: [{
    recordId: 'rec001', stationSlug: 'sub-api-example-com', title: '示例站 · 使用评价', summary: '挺稳', body: '挺稳，<script>alert(1)</script>',
    authorName: '群友甲', publishedAt: '2026-11-04T08:00:00.000Z',
  }],
};

async function runImport(store: ReturnType<typeof newStore>, input: unknown) {
  const response = importResponse(store, JSON.stringify(input));
  return { status: response.status, body: await response.json() as { changed: boolean; error?: { code: string; message: string } } };
}

describe('全量导入', () => {
  it('导入后读得到站点、报价、文章，且可用率等指标是 null', async () => {
    const store = newStore();
    expect(await runImport(store, submission)).toMatchObject({ status: 200, body: { changed: true, stations: 1, offers: 2, posts: 1 } });
    const app = buildApp(store, now);
    const station = await (await app.request('/api/stations/sub-api-example-com')).json() as StationDetail;
    expect(station).toMatchObject({ name: '示例站', source: 'submission', url: 'https://api.example.com/', uptime: null, firstTokenLatencyMs: null, score: null, lowestRate: 0.5 });
    const post = await (await app.request('/api/posts/feishu-rec001')).json() as Post;
    expect(post).toMatchObject({ kind: 'review', source: 'submission', stationSlug: 'sub-api-example-com', body: '挺稳，<script>alert(1)</script>', author: { nickname: '群友甲' } });
  });

  it('重复导入相同内容不产生重复', async () => {
    const store = newStore();
    await runImport(store, submission);
    expect((await runImport(store, submission)).body).toMatchObject({ changed: false });
    expect(store.all('station')).toHaveLength(13);
    expect(store.all('post')).toHaveLength(49);
    expect(submittedOffers(store)).toHaveLength(2);
  });

  it('下一次全量导入里没有的记录会消失，演示数据不受影响', async () => {
    const store = newStore();
    await runImport(store, submission);
    expect((await runImport(store, { stations: [], posts: [] })).body).toMatchObject({ changed: true });
    expect(store.get('station', 'sub-api-example-com')).toBeUndefined();
    expect(store.get('post', 'feishu-rec001')).toBeUndefined();
    expect(submittedOffers(store)).toEqual([]);
    expect(store.all('station')).toHaveLength(12);
    expect(store.all('post')).toHaveLength(48);
  });

  it.each([0.05, 20])('接受倍率边界 %s', async rate => {
    const store = newStore();
    const input = { ...submission, stations: [{ ...submission.stations[0], offers: [{ modelSlug: 'o3', rate }] }] };
    expect(await runImport(store, input)).toMatchObject({ status: 200, body: { changed: true } });
  });

  it.each([
    ['非 http(s) 网址', { ...submission, stations: [{ ...submission.stations[0], url: 'javascript:alert(1)' }] }],
    ['带 query 的网址', { ...submission, stations: [{ ...submission.stations[0], url: 'https://a.com/?aff=1' }] }],
    ['带 fragment 的网址', { ...submission, stations: [{ ...submission.stations[0], url: 'https://a.com/#aff' }] }],
    ['倍率低于范围', { ...submission, stations: [{ ...submission.stations[0], offers: [{ modelSlug: 'o3', rate: 0.04 }] }] }],
    ['倍率为 0', { ...submission, stations: [{ ...submission.stations[0], offers: [{ modelSlug: 'o3', rate: 0 }] }] }],
    ['倍率为负数', { ...submission, stations: [{ ...submission.stations[0], offers: [{ modelSlug: 'o3', rate: -1 }] }] }],
    ['倍率高于范围', { ...submission, stations: [{ ...submission.stations[0], offers: [{ modelSlug: 'o3', rate: 20.01 }] }] }],
    ['未知模型', { ...submission, stations: [{ ...submission.stations[0], offers: [{ modelSlug: 'nope', rate: 1 }] }] }],
    ['关联了不存在的站点', { ...submission, posts: [{ ...submission.posts[0], stationSlug: 'sub-nope' }] }],
    ['重复的站点', { ...submission, stations: [submission.stations[0], submission.stations[0]] }],
    ['slug 不带来源前缀', { ...submission, stations: [{ ...submission.stations[0], slug: 'whale-demo' }], posts: [] }],
    ['多余字段', { ...submission, reviewNote: '审核备注' }],
    ['不是合法结构', 'x'],
  ])('拒绝%s，数据不变', async (_name, input) => {
    const store = newStore();
    const result = await runImport(store, input);
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe('INVALID_INPUT');
    if (typeof input !== 'string' && ['倍率低于范围', '倍率高于范围', '倍率为 0', '倍率为负数'].includes(_name)) {
      expect(result.body.error?.message).toContain(String(input.stations[0].offers[0].rate));
    }
    expect(store.all('station')).toHaveLength(12);
  });
});

describe('authorizeAdmin', () => {
  const status = async (header: string | undefined, token: string | undefined) => (await authorizeAdmin(header, token))?.status ?? 'pass';

  it('未配置密钥时一律拒绝，哪怕请求带了空 token', async () => {
    expect(await status('Bearer anything', undefined)).toBe(403);
    expect(await status('Bearer ', '')).toBe(403);
    expect(await status(undefined, undefined)).toBe(403);
  });

  it('缺少或格式错误的 Authorization 返回 401', async () => {
    expect(await status(undefined, 'secret')).toBe(401);
    expect(await status('Basic secret', 'secret')).toBe(401);
    expect(await status('Bearer ', 'secret')).toBe(401);
  });

  it('错 token 返回 403，对 token 放行', async () => {
    expect(await status('Bearer wrong', 'secret')).toBe(403);
    expect(await status('Bearer secre', 'secret')).toBe(403);
    expect(await status('Bearer secret', 'secret')).toBe('pass');
  });
});

describe('全量导入与软删除', () => {
  it('导入不清空已下架站点的报价，否则恢复出来是个没有报价的空站', async () => {
    const store = newStore();
    expect(await runImport(store, submission)).toMatchObject({ status: 200 });
    // 下架：软删除只打标记，报价与实体都留着，等恢复接口用。
    store.db.prepare("UPDATE entities SET removedAt = ? WHERE id = 'sub-api-example-com'").run('2026-11-06T02:00:00.000Z');
    expect(submittedOffers(store)).toHaveLength(2);

    // 再跑一次全量导入（这次表里没有这个站点了，相当于它被移出收集表）。
    expect(await runImport(store, { stations: [], posts: [] })).toMatchObject({ status: 200 });
    expect(submittedOffers(store)).toHaveLength(2);
  });
});

describe('allowNewModels 自动收录', () => {
  it('不会覆盖已存在模型，也不会产生查不到模型的孤儿报价', async () => {
    const store = newStore();
    const before = store.get('model', 'gpt-4-1');
    expect(before).toBeTruthy();

    // 已存在的模型再出现在报价里，不该被占位内容覆盖。
    // 带空格的写法归一后就是 gpt-4-1，命中已有模型，于是走不到「自动收录」那条路。
    const conflicting = { stations: [{
      slug: 'sub-conflict', name: '站', description: 'd', url: 'https://conflict.example.com/',
      rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: ' gpt-4-1 ', rate: 0.5 }],
    }], posts: [] };
    const result = await runImport(store, { ...conflicting, allowNewModels: true });
    expect(result.status).toBe(200);
    expect((result.body as { createdModels?: string[] }).createdModels ?? []).toEqual([]);
    // 管理员维护的厂商、名称、描述必须原样保留。
    expect(store.get('model', 'gpt-4-1')).toEqual(before);
    // 报价也落在归一后的 slug 上，不是原样的 ' gpt-4-1 '。
    expect(store.db.prepare("SELECT modelSlug FROM offers WHERE stationSlug = 'sub-conflict'").all())
      .toEqual([{ modelSlug: 'gpt-4-1' }]);
  });

  it('新模型的报价用解析后的 slug 落库，不留孤儿', async () => {
    const store = newStore();
    const fresh = { stations: [{
      slug: 'sub-fresh', name: '站', description: 'd', url: 'https://fresh.example.com/',
      rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'brand-new-model', rate: 0.5 }],
    }], posts: [], allowNewModels: true };
    expect(await runImport(store, fresh)).toMatchObject({ status: 200 });
    const orphans = store.db.prepare('SELECT o.modelSlug FROM offers o LEFT JOIN entities m ON m.id = o.modelSlug AND m.kind = \'model\' WHERE m.id IS NULL').all();
    expect(orphans).toEqual([]);
  });
});

describe('删除模型', () => {
  it('待审投稿引用模型时拒绝删除，否则那条投稿永远过不了审核', async () => {
    const store = newStore();
    // 先建一个没有任何引用的模型，再让一条待审站点投稿引用它。
    store.put('model', 'temp-model', { slug: 'temp-model', vendor: 'anthropic', name: '临时模型', description: '', tags: [] });
    // 走真实的投稿入队路径（全量导入不产生 submissions 行，它是直接物化的）。
    enqueueSubmission(store, {
      kind: 'station', channel: 'agent', originKey: 'pending.example.com', ip: '1.2.3.4', now: new Date('2026-11-06T03:00:00Z'),
      payload: { name: '站', description: 'd', url: 'https://pending.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'temp-model', rate: 0.5 }] },
    }, { globalPendingBreaker: false });
    expect(Number(store.db.prepare("SELECT count(*) AS c FROM submissions WHERE status = 'pending'").get()!.c)).toBe(1);

    // 删除会被拒绝并说明是待审投稿占着。
    expect(() => deleteModel(store, 'temp-model')).toThrow(/待审投稿/);
  });
});

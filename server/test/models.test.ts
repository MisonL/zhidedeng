import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogImportRequest, VendorWithModels } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const json = { 'content-type': 'application/json' };
const admin = { ...json, authorization: `Bearer ${TOKEN}` };

const clock = () => new Date('2026-11-06T01:00:00Z');

let server: ReturnType<typeof createApp>;
beforeEach(() => {
  server = createApp({ dbPath: ':memory:', now: clock, syncToken: TOKEN });
});
afterEach(() => server.db.close());

const addModel = (body: unknown, headers: Record<string, string> = admin) =>
  server.app.request('/api/admin/models', { method: 'POST', headers, body: JSON.stringify(body) });
const removeModel = (slug: string, body: unknown = { confirm: true }, headers: Record<string, string> = admin) =>
  server.app.request(`/api/admin/models/${slug}`, { method: 'DELETE', headers, body: JSON.stringify(body) });
const addVendor = (body: unknown, headers: Record<string, string> = admin) =>
  server.app.request('/api/admin/vendors', { method: 'POST', headers, body: JSON.stringify(body) });
const importCatalog = (payload: unknown) =>
  server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(payload) });
const readModel = (slug: string) => server.app.request(`/api/models/${slug}`);
const vendorList = async () => await (await server.app.request('/api/vendors?pageSize=50')).json() as { items: VendorWithModels[] };

const offeredModel = () => {
  const row = server.db.prepare("SELECT modelSlug, COUNT(DISTINCT stationSlug) AS count FROM offers GROUP BY modelSlug ORDER BY count DESC LIMIT 1").get();
  return { slug: row!.modelSlug as string, stationCount: Number(row!.count) };
};

const submission = (offers: { modelSlug: string; rate: number }[]): CatalogImportRequest => ({
  stations: [{
    slug: 'sub-real-site', name: '真实推荐站', description: '群友推荐的站点，未被平台核实',
    url: 'https://api.example.com/', rechargeThreshold: 10, paymentMethods: ['支付宝'], offers,
  }],
  posts: [],
});

describe('新增模型', () => {
  it('创建成功后 GET /api/vendors 能看到', async () => {
    const response = await addModel({ slug: 'claude-sonnet-4-5-20250929', vendor: 'anthropic', name: 'Claude Sonnet 4.5', description: '中转站常见的完整模型 ID' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      slug: 'claude-sonnet-4-5-20250929', vendor: 'anthropic', name: 'Claude Sonnet 4.5', tags: [],
    });

    const vendors = await vendorList();
    const anthropic = vendors.items.find(vendor => vendor.slug === 'anthropic')!;
    expect(anthropic.models.map(model => model.slug)).toContain('claude-sonnet-4-5-20250929');
    expect(((await readModel('claude-sonnet-4-5-20250929')).status)).toBe(200);
  });

  it('slug 重复返回 409', async () => {
    const body = { slug: 'claude-sonnet-4-5-20250929', vendor: 'anthropic', name: '重名', description: '重复创建' };
    expect((await addModel(body)).status).toBe(200);
    const second = await addModel(body);
    expect(second.status).toBe(409);
    expect((await second.json())).toMatchObject({ error: { code: 'MODEL_EXISTS' } });
  });

  it('vendor 不存在返回 400', async () => {
    const response = await addModel({ slug: 'brand-new', vendor: 'no-such-vendor', name: '没厂商的模型', description: '写不进去' });
    expect(response.status).toBe(400);
    expect((await response.json())).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect((await readModel('brand-new')).status).toBe(404);
  });

  it('非法 slug 或超长字段返回 400', async () => {
    for (const body of [
      { slug: 'Upper_Case', vendor: 'openai', name: '非法 slug', description: '大小写和下划线都不行' },
      { slug: 'x'.repeat(65), vendor: 'openai', name: '太长', description: '超过 64 位' },
      { slug: 'too-long-name', vendor: 'openai', name: 'x'.repeat(61), description: '名字超长' },
      { slug: 'too-long-desc', vendor: 'openai', name: '描述超长', description: 'x'.repeat(201) },
      { slug: 'extra-field', vendor: 'openai', name: '多余字段', description: '多了个 tags' },
    ]) {
      const response = await addModel({ ...body, tags: ['多余'] });
      expect(response.status).toBe(400);
    }
  });

  it('新增厂商后可以给它加模型，重复厂商返回 409', async () => {
    const vendor = await addVendor({ slug: 'stepfun', name: '阶跃星辰' });
    expect(vendor.status).toBe(200);
    expect(await vendor.json()).toEqual({ slug: 'stepfun', name: '阶跃星辰', iconKey: 'stepfun' });

    expect((await addModel({ slug: 'step-2', vendor: 'stepfun', name: 'Step 2', description: '新厂商的第一个模型' })).status).toBe(200);
    const vendors = await vendorList();
    expect(vendors.items.find(item => item.slug === 'stepfun')!.models.map(model => model.slug)).toEqual(['step-2']);

    const again = await addVendor({ slug: 'stepfun', name: '阶跃星辰', iconKey: 'openai' });
    expect(again.status).toBe(409);
    expect((await again.json())).toMatchObject({ error: { code: 'VENDOR_EXISTS' } });
  });
});

describe('删除模型', () => {
  it('被 offers 引用的模型返回 409 并给出引用站点数', async () => {
    const { slug, stationCount } = offeredModel();
    expect(stationCount).toBeGreaterThan(0);

    const response = await removeModel(slug);
    expect(response.status).toBe(409);
    expect((await response.json())).toMatchObject({ error: { code: 'MODEL_IN_USE', stationCount } });
    expect(((await readModel(slug)).status)).toBe(200);
  });

  it('被文章引用的模型也返回 409，不会留下悬空的 modelSlug', async () => {
    const slug = 'referenced-by-post';
    expect((await addModel({ slug, vendor: 'openai', name: '被文章引用', description: '删除应被拒绝' })).status).toBe(200);
    server.db.prepare('INSERT INTO entities (kind,id,data) VALUES (?,?,?)').run('post', 'post-ref-model', JSON.stringify({
      id: 'post-ref-model', kind: 'review', title: '引用模型的文章', summary: '摘要', body: '正文',
      authorHandle: 'demo-pedal', stationSlug: null, modelSlug: slug, cover: null,
      publishedAt: '2026-11-06T00:00:00.000Z', status: 'approved', source: 'demo',
    }));

    const response = await removeModel(slug);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'MODEL_IN_USE', stationCount: 0, postCount: 1 } });
    expect((await readModel(slug)).status).toBe(200);
  });

  it('未被引用的模型可以删除', async () => {
    expect((await addModel({ slug: 'to-be-deleted', vendor: 'openai', name: '待删除', description: '建出来再删掉' })).status).toBe(200);
    const response = await removeModel('to-be-deleted');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: 'to-be-deleted', deleted: true });
    expect(((await readModel('to-be-deleted')).status)).toBe(404);
  });

  it('要求显式确认，删除不存在的模型返回 404', async () => {
    expect(((await addModel({ slug: 'needs-confirm', vendor: 'openai', name: '要确认', description: '没确认不删' })).status)).toBe(200);
    const unconfirmed = await removeModel('needs-confirm', { confirm: false });
    expect(unconfirmed.status).toBe(400);
    expect(((await addModel({ slug: 'needs-confirm', vendor: 'openai', name: '要确认', description: '没确认不删' })).status)).toBe(409);
    const missing = await removeModel('never-existed');
    expect(missing.status).toBe(404);
    expect(((await removeModel('needs-confirm')).status)).toBe(200);
  });
});

describe('模型管理接口鉴权', () => {
  it('沿用现有 admin 鉴权：缺 token 401，错 token 403，未配置密钥 403', async () => {
    const noToken = { 'content-type': 'application/json' };
    expect((await addModel({ slug: 'nope', vendor: 'openai', name: '没有 token', description: '进不来' }, noToken)).status).toBe(401);
    expect((await addModel({ slug: 'nope', vendor: 'openai', name: '错 token', description: '进不来' }, { ...noToken, authorization: 'Bearer wrong-token' })).status).toBe(403);
    expect((await removeModel('gpt-4-1', { confirm: true }, noToken)).status).toBe(401);
    expect((await addVendor({ slug: 'nope-vendor', name: '没有 token' }, noToken)).status).toBe(401);
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: noToken, body: '{}' })).status).toBe(401);

    const unconfigured = createApp({ dbPath: ':memory:', now: clock });
    expect((await unconfigured.app.request('/api/admin/models', { method: 'POST', headers: noToken, body: '{}' })).status).toBe(403);
  });

  it('写接口要求 content-type 为 application/json', async () => {
    const form = await server.app.request('/api/admin/models', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: 'slug=a-vendor-b' });
    expect(form.status).toBe(415);
  });
});

describe('导入时放宽模型校验', () => {
  it('默认仍拒绝未知模型，且不写入任何数据', async () => {
    const response = await importCatalog(submission([{ modelSlug: 'claude-sonnet-4-5-20250929', rate: 0.6 }]));
    expect(response.status).toBe(400);
    expect((await response.json())).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(((await readModel('claude-sonnet-4-5-20250929')).status)).toBe(404);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE json_extract(data,'$.source') = 'submission'").get()!.count).toBe(0);
  });

  it('allowNewModels 为 true 时创建占位模型并返回 createdModels', async () => {
    const response = await importCatalog({ ...submission([{ modelSlug: 'claude-sonnet-4-5-20250929', rate: 0.6 }]), allowNewModels: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      changed: true, stations: 1, offers: 1, posts: 0, createdModels: ['claude-sonnet-4-5-20250929'],
    });

    expect(await (await readModel('claude-sonnet-4-5-20250929')).json()).toMatchObject({
      slug: 'claude-sonnet-4-5-20250929', vendor: 'unknown', name: 'claude-sonnet-4-5-20250929',
      description: '群友/Agent 提交时自动创建，待补全', tags: [],
    });
    // 未知厂商下能看到这些模型，前端图标也能兜底。
    expect((await vendorList()).items.find(vendor => vendor.slug === 'unknown')!.models.map(model => model.slug))
      .toEqual(['claude-sonnet-4-5-20250929']);
    // 站点与报价照常写入。
    expect(((await server.app.request('/api/stations/sub-real-site')).status)).toBe(200);

    const again = await importCatalog({ ...submission([{ modelSlug: 'claude-sonnet-4-5-20250929', rate: 0.6 }]), allowNewModels: true });
    expect(await again.json()).toMatchObject({ changed: false, createdModels: [] });
  });

  it('allowNewModels 显式为 false 时仍拒绝', async () => {
    expect(((await importCatalog({ ...submission([{ modelSlug: 'claude-sonnet-4-5-20250929', rate: 0.6 }]), allowNewModels: false })).status)).toBe(400);
    expect(((await readModel('claude-sonnet-4-5-20250929')).status)).toBe(404);
  });

  it('多个未知模型只建一次，按 slug 排序返回', async () => {
    const input = submission([{ modelSlug: 'zzz-model', rate: 0.6 }, { modelSlug: 'aaa-model', rate: 0.5 }]);
    input.stations.push({ ...input.stations[0], slug: 'sub-second-site', offers: [{ modelSlug: 'zzz-model', rate: 0.7 }] });
    const response = await importCatalog({ ...input, allowNewModels: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stations: 2, offers: 3, createdModels: ['aaa-model', 'zzz-model'] });
    const row = server.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind = 'model' AND json_extract(data,'$.vendor') = 'unknown'").get()!;
    expect(Number(row.count)).toBe(2);
  });
});

describe('GET 参数归一', () => {
  const get = (path: string) => server.app.request(path, {}, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });

  it('无关的查询参数被丢弃，不会让整页 400', async () => {
    // 分享链接会带 utm_source，监控会带 _t。读接口不该因为这些整页失败。
    expect((await get('/api/models?page=1&utm_source=wechat')).status).toBe(200);
    expect((await get('/api/models?page=1&_t=1700000000')).status).toBe(200);
  });

  it('空串按没传处理', async () => {
    // 外部调用方拼 `?vendor=${vendor}` 而 vendor 为空时，不该被 min(1) 挡下。
    expect((await get('/api/models?vendor=')).status).toBe(200);
  });

  it('认识的参数照常生效', async () => {
    const ok = await get('/api/models?pageSize=2');
    const body = await ok.json() as { items: unknown[]; pageSize: number };
    expect(ok.status).toBe(200);
    expect(body.pageSize).toBe(2);
    expect(body.items.length).toBeLessThanOrEqual(2);
  });
});

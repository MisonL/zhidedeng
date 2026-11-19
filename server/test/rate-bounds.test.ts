import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GetRankingsResponse, GetStationsResponse, ModelDetail } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';
import { Service } from '../src/service.ts';

let server: ReturnType<typeof createApp>;

beforeEach(() => {
  server = createApp({ dbPath: ':memory:', now: () => new Date('2026-11-06T01:00:00Z') });
  server.db.prepare('DELETE FROM offers').run();
});

afterEach(() => server.db.close());

const stationSlugs = () => server.db.prepare("SELECT id FROM entities WHERE kind = 'station' ORDER BY rowid").all().map(row => String(row.id));
const modelSlugs = () => server.db.prepare("SELECT id FROM entities WHERE kind = 'model' ORDER BY rowid").all().map(row => String(row.id));
const insertOffer = (stationSlug: string, modelSlug: string, rate: number, basis = 'blended') => {
  server.db.prepare('INSERT INTO offers (stationSlug,modelSlug,rate,basis) VALUES (?,?,?,?)').run(stationSlug, modelSlug, rate, basis);
};

async function getRankings() {
  const response = await server.app.request('/api/rankings?tab=model&pageSize=50');
  return await response.json() as GetRankingsResponse;
}

describe('报价倍率展示与榜单门槛', () => {
  it('模型榜保留真实最低倍率，三条报价后才启用低价加成', async () => {
    const stations = stationSlugs();
    const model = modelSlugs()[0];
    insertOffer(stations[0], model, 0.05);
    insertOffer(stations[1], model, 0.6);

    let ranking = await getRankings();
    if (ranking.tab !== 'model') throw new Error('排行榜类型错误');
    expect(ranking.items.find(item => item.model.slug === model)).toMatchObject({ stationCount: 2, lowestRate: 0.05 });

    insertOffer(stations[2], model, 0.7);
    ranking = await getRankings();
    if (ranking.tab !== 'model') throw new Error('排行榜类型错误');
    expect(ranking.items.find(item => item.model.slug === model)).toMatchObject({ stationCount: 3, lowestRate: 0.05 });

    const detailResponse = await server.app.request(`/api/models/${model}`);
    const detail = await detailResponse.json() as ModelDetail;
    expect(detail.offers.map(offer => offer.station.lowestRate)).toEqual([0.05, 0.6, 0.7]);
  });

  it('单个 0.05 报价不能压过三个 0.6 报价的模型', async () => {
    const stations = stationSlugs();
    const [maliciousModel, regularModel] = modelSlugs();
    insertOffer(stations[0], maliciousModel, 0.05);
    for (const station of stations.slice(1, 4)) insertOffer(station, regularModel, 0.6);

    const ranking = await getRankings();
    if (ranking.tab !== 'model') throw new Error('排行榜类型错误');
    expect(ranking.items[0]).toMatchObject({ model: { slug: regularModel }, stationCount: 3, lowestRate: 0.6 });
    expect(ranking.items.find(item => item.model.slug === maliciousModel)).toMatchObject({ stationCount: 1, lowestRate: 0.05 });
  });

  it('站点按倍率排序时不足三个报价的站点排在达标站点后', async () => {
    const stations = stationSlugs();
    const models = modelSlugs();
    const [maliciousStation, regularStation] = stations;
    insertOffer(maliciousStation, models[0], 0.05);
    for (const model of models.slice(0, 3)) insertOffer(regularStation, model, 0.6);

    const response = await server.app.request('/api/stations?sort=rate&pageSize=50');
    const result = await response.json() as GetStationsResponse;
    const maliciousIndex = result.items.findIndex(item => item.slug === maliciousStation);
    const regularIndex = result.items.findIndex(item => item.slug === regularStation);
    expect(result.items[maliciousIndex].lowestRate).toBe(0.05);
    expect(result.items[regularIndex].lowestRate).toBe(0.6);
    expect(regularIndex).toBeLessThan(maliciousIndex);
  });
});

describe('计价口径对最低倍率的影响', () => {
  it('只有非综合报价的站不能排在真正有综合低价的站前面', async () => {
    // 「按输入 0.1」这种报价让 offers 条数达标、却算不出最低倍率（null）。
    // 原先的排序是「先按条数门槛分组，再按 lowestRate」，于是这个站被分到
    // 门槛达标组、lowestRate 又是 null → 排到 ?sort=rate 的第一位，
    // 而它其实没有任何可与「0.5x」比较的价格。
    // 这条断言读原始 DTO（服务端已返回过的 JSON），null 与 Infinity 在这里
    // 都是 null，所以先断言 null **再**断言它排在真实报价站之后，两者缺一不可：
    // 前者锁取数口径，后者锁排序行为。
    const stations = stationSlugs();
    const models = modelSlugs();
    for (const model of models.slice(0, 3)) insertOffer(stations[0], model, 0.1, 'input');
    insertOffer(stations[1], models[0], 0.5);
    const response = await server.app.request('/api/stations?sort=rate&pageSize=100');
    const body = await response.json() as GetStationsResponse;
    const onlyInput = body.items.find(item => item.slug === stations[0])!;
    const realRate = body.items.find(item => item.slug === stations[1])!;
    expect(onlyInput.lowestRate).toBeNull();
    expect(realRate.lowestRate).toBe(0.5);
    expect(body.items.indexOf(realRate)).toBeLessThan(body.items.indexOf(onlyInput));
  });

  it('模型榜的最低倍率只算综合口径，其余口径不参与取最小', async () => {
    // 「按输入 0.1」只对输入 token 成立。把它算进模型榜最低倍率，等于
    // 用一个局部价把整个模型顶到榜首，而榜单暗示的是「这个模型最便宜」。
    const stations = stationSlugs();
    const model = modelSlugs()[0];
    insertOffer(stations[0], model, 0.8);                 // blended
    insertOffer(stations[1], model, 0.1, 'input');        // 不可比
    insertOffer(stations[2], model, 0.2, 'output');       // 不可比
    const ranking = await getRankings();
    const item = ranking.items.find(entry => 'model' in entry && entry.model.slug === model);
    expect(item).toMatchObject({ stationCount: 3, lowestRate: 0.8 });
  });

  it('模型榜的可比报价门槛只数综合口径，与站点排序口径一致', async () => {
    // 之前 count（全口径）用于门槛、lowest 只算综合：一个模型有 3 条报价但
    // 只有 1 条综合时，会被判「够格参与低价加成」却算不出可比最低价——
    // 自相矛盾。两处门槛必须同口径。
    const stations = stationSlugs();
    const model = modelSlugs()[0];
    // 那条唯一的综合报价故意压到 0.05：如果门槛错用全口径，它会被判「够格」，
    // 低价加成 1/0.05 = 20 直接把 score 顶到 23，超过对照模型的 3 + 1/0.6 ≈ 4.67。
    // 用 0.8 这种不痛不痒的值测不出区别——两边都是对照模型在前，断言就空转了。
    insertOffer(stations[0], model, 0.05);
    insertOffer(stations[1], model, 0.1, 'input');
    insertOffer(stations[2], model, 0.2, 'output');
    // 对照模型：三条全是综合报价 0.6，同样 3 个报站。
    const regular = modelSlugs()[1];
    for (const station of stations.slice(3, 6)) insertOffer(station, regular, 0.6);
    const ranking = await getRankings();
    if (ranking.tab !== 'model') throw new Error('排行榜类型错误');
    expect(ranking.items.find(entry => entry.model.slug === model)).toMatchObject({ stationCount: 3, lowestRate: 0.05 });
    const punished = ranking.items.findIndex(entry => 'model' in entry && entry.model.slug === model);
    const regularIndex = ranking.items.findIndex(entry => 'model' in entry && entry.model.slug === regular);
    expect(regularIndex).toBeLessThan(punished);
  });

  it('只有非综合口径报价时，模型榜最低倍率为 null 而不是 Infinity', async () => {
    const stations = stationSlugs();
    const model = modelSlugs()[0];
    insertOffer(stations[0], model, 0.1, 'input');
    insertOffer(stations[1], model, 0.2, 'package');
    const ranking = await getRankings();
    // 榜单是联合类型（模型/社区/专家），先窄到模型榜再取字段。
    const item = ranking.items.find(entry => 'model' in entry && entry.model.slug === model) as Extract<typeof ranking.items[number], { model: unknown }>;
    // Infinity 会被 JSON.stringify 变成 null，但这里要的是「真的没有可比报价」，
    // 而不是碰巧序列化成了 null——直接断言值本身。
    expect(item.lowestRate).toBeNull();
    expect(item.stationCount).toBe(2);

    // 上面这条断言不足以锁住实现：服务端把 Infinity 交给 JSON.stringify 也会
    // 得到 null，所以「删掉 Number.isFinite 守护」照样能过（已实测）。
    // 直接问 Service 要对象看真值，才能区分「真的算不出」和「序列化碰巧对了」。
    const service = new Service(server.store, () => new Date('2026-11-06T01:00:00Z'), null);
    const raw = service.getRankings({ tab: 'model', page: 1, pageSize: 50 });
    if (raw.tab !== 'model') throw new Error('排行榜类型错误');
    const rawItem = raw.items.find(entry => entry.model.slug === model)!;
    expect(rawItem.lowestRate).toBeNull();
    // 不是 Infinity、不是 NaN：这两种值进 DTO 就是实现 bug，JSON 帮我们掩盖了
    expect(Number.isFinite(rawItem.lowestRate as number)).toBe(false);
  });
});

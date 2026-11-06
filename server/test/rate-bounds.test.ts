import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GetRankingsResponse, GetStationsResponse, ModelDetail } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

let server: ReturnType<typeof createApp>;

beforeEach(() => {
  server = createApp({ dbPath: ':memory:', now: () => new Date('2026-11-06T01:00:00Z') });
  server.db.prepare('DELETE FROM offers').run();
});

afterEach(() => server.db.close());

const stationSlugs = () => server.db.prepare("SELECT id FROM entities WHERE kind = 'station' ORDER BY rowid").all().map(row => String(row.id));
const modelSlugs = () => server.db.prepare("SELECT id FROM entities WHERE kind = 'model' ORDER BY rowid").all().map(row => String(row.id));
const insertOffer = (stationSlug: string, modelSlug: string, rate: number) => {
  server.db.prepare('INSERT INTO offers (stationSlug,modelSlug,rate) VALUES (?,?,?)').run(stationSlug, modelSlug, rate);
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

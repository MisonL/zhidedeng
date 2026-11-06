import type {
  Banner, CurrentUser, GetRankingsResponse, ModelRanking, Post, Station, VendorWithModels,
} from '@zhidedeng/shared';

export const me: CurrentUser = {
  handle: 'demo-pedal', nickname: '虚构踏板', avatar: '', bio: '蹬得开心', tokens: 1280,
  checkedInToday: false, streak: 3, favoriteCount: 2, shareCount: 1,
};

export const banners: Banner[] = [
  { id: 'b1', title: '鲸鱼新版评测', description: 'DeepSeek 大肥鱼', image: '/banners/whale.webp', href: '/reviews' },
  { id: 'b2', title: '蹬车省钱指南', description: '倍率怎么看', image: '/banners/pedal.webp', href: '/community' },
  { id: 'b3', title: '罗盘选站手册', description: '选站不迷路', image: '/banners/compass.webp', href: '/stations' },
];

export const vendors: VendorWithModels[] = [
  {
    slug: 'deepseek', name: 'DeepSeek', iconKey: 'deepseek',
    models: [{ slug: 'deepseek-v4', vendor: 'deepseek', name: 'DeepSeek V4', description: '大肥鱼', tags: ['推理'] }],
  },
  {
    slug: 'openai', name: 'OpenAI', iconKey: 'openai',
    models: [{ slug: 'gpt-5', vendor: 'openai', name: 'GPT-5', description: '通用旗舰', tags: ['多模态'] }],
  },
];

export const station: Station = {
  slug: 'yunzhan', name: '云栈', description: '虚构样例站点', rechargeThreshold: 10,
  paymentMethods: ['支付宝'], uptime: 99.2, firstTokenLatencyMs: 420, foundedAt: '2024-05-01',
  status: 'running', lowestRate: 0.6, score: 92, url: null, source: 'demo',
  votes: { up: 30, down: 10, total: 40, upRatio: 0.75 }, currentUserVote: null,
  favorited: false, favoriteCount: 5, commentCount: 2,
};

export function makePost(id: string, patch: Partial<Post> = {}): Post {
  return {
    id, kind: 'deal', title: `爆料 ${id}`, summary: `摘要 ${id}`, body: `正文 ${id}`,
    author: { handle: 'demo-pedal', nickname: '虚构踏板', avatar: '' },
    stationSlug: 'yunzhan', modelSlug: 'deepseek-v4', cover: null, source: 'demo', status: 'approved',
    publishedAt: '2026-11-03T08:00:00.000Z',
    votes: { up: 3, down: 1, total: 4, upRatio: 0.75 }, currentUserVote: null,
    favorited: false, favoriteCount: 7, commentCount: 2,
    ...patch,
  };
}

export const modelRanking: ModelRanking = {
  rank: 1, model: vendors[0].models[0], lowestRate: 0.5, stationCount: 8,
};

export function rankings(tab: 'model' | 'community' | 'expert'): GetRankingsResponse {
  const base = { total: 1, page: 1, pageSize: 6 };
  if (tab === 'model') return { ...base, tab, items: [modelRanking] };
  if (tab === 'community') return { ...base, tab, items: [{ rank: 1, post: makePost('hot', { title: '社区热帖一号' }) }] };
  return {
    ...base, tab,
    items: [{ rank: 1, user: { handle: 'ace', nickname: '蹬车达人', avatar: '', bio: '只测不吹', tokens: 900 }, shareCount: 12, upCount: 340 }],
  };
}

export function page<T>(items: T[], total = items.length, pageNo = 1) {
  return { items, total, page: pageNo, pageSize: 10 };
}

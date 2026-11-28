import type { ApiContracts } from './api.js';

export const API_ROUTES = {
  register: { method: 'POST', path: '/api/auth/register' },
  login: { method: 'POST', path: '/api/auth/login' },
  logout: { method: 'POST', path: '/api/auth/logout' },
  changePassword: { method: 'POST', path: '/api/auth/password' },
  createAgentToken: { method: 'POST', path: '/api/account/agent-tokens' },
  getAgentTokens: { method: 'GET', path: '/api/account/agent-tokens' },
  revokeAgentToken: { method: 'DELETE', path: '/api/account/agent-tokens/:id' },
  createAgentStation: { method: 'POST', path: '/api/agent/stations' },
  createAgentPost: { method: 'POST', path: '/api/agent/posts' },
  createAgentModel: { method: 'POST', path: '/api/agent/models' },
  suggestModel: { method: 'POST', path: '/api/models/suggest' },
  suggestStation: { method: 'POST', path: '/api/stations/suggest' },
  getAgentStatus: { method: 'GET', path: '/api/agent/status' },
  getMe: { method: 'GET', path: '/api/me' },
  updateMe: { method: 'PATCH', path: '/api/me' },
  checkIn: { method: 'POST', path: '/api/me/checkin' },
  getMyFavorites: { method: 'GET', path: '/api/me/favorites' },
  getMyPosts: { method: 'GET', path: '/api/me/posts' },
  getMySubmissions: { method: 'GET', path: '/api/me/submissions' },
  getMyNotifications: { method: 'GET', path: '/api/me/notifications' },
  getVendors: { method: 'GET', path: '/api/vendors' },
  getModels: { method: 'GET', path: '/api/models' },
  getModel: { method: 'GET', path: '/api/models/:slug' },
  getStations: { method: 'GET', path: '/api/stations' },
  getStation: { method: 'GET', path: '/api/stations/:slug' },
  getPosts: { method: 'GET', path: '/api/posts' },
  getPost: { method: 'GET', path: '/api/posts/:id' },
  getUser: { method: 'GET', path: '/api/users/:handle' },
  createFeedback: { method: 'POST', path: '/api/feedback' },
  getFeedback: { method: 'GET', path: '/api/feedback' },
  deleteFeedback: { method: 'DELETE', path: '/api/feedback/:id' },
  createPost: { method: 'POST', path: '/api/posts' },
  // 注销账号。POST 而不是 DELETE：DELETE 走不通带正文的 CSRF 校验。
  deleteAccount: { method: 'POST', path: '/api/me/delete' },
  // Token 消耗：余额+商店、流水、兑换。
  getMyTokens: { method: 'GET', path: '/api/me/tokens' },
  getTokenLedger: { method: 'GET', path: '/api/me/tokens/ledger' },
  redeemTokens: { method: 'POST', path: '/api/me/tokens/redeem' },
  // 编辑已发布文章：PUT 提交修改（进审核队列），GET 读待审/被拒那一版，
  // DELETE 撤回修改。三个都挂在同一篇文章的 revision 子资源上。
  submitRevision: { method: 'PUT', path: '/api/posts/:id/revision' },
  getRevision: { method: 'GET', path: '/api/posts/:id/revision' },
  withdrawRevision: { method: 'DELETE', path: '/api/posts/:id/revision' },
  deletePost: { method: 'DELETE', path: '/api/posts/:id' },
  createReport: { method: 'POST', path: '/api/reports' },
  putVote: { method: 'PUT', path: '/api/votes' },
  putFavorite: { method: 'PUT', path: '/api/favorites' },
  getComments: { method: 'GET', path: '/api/comments' },
  createComment: { method: 'POST', path: '/api/comments' },
  deleteComment: { method: 'DELETE', path: '/api/comments/:id' },
  getRankings: { method: 'GET', path: '/api/rankings' },
  getBanners: { method: 'GET', path: '/api/banners' },
  search: { method: 'GET', path: '/api/search' },
  getHotSearches: { method: 'GET', path: '/api/hot-searches' },
  // 站点级公开信息（当前联系方式）。运维没配时返回 null，前端据此说「暂未开通」，
  // 而不是编一个邮箱、也不是让所有「联系管理员」的提示指向一句「待配置」。
  getSite: { method: 'GET', path: '/api/site' },
  createInviteCode: { method: 'POST', path: '/api/admin/invite-codes' },
  getInviteCodes: { method: 'GET', path: '/api/admin/invite-codes' },
  revokeInviteCode: { method: 'POST', path: '/api/admin/invite-codes/:id/revoke' },
} as const satisfies Record<keyof ApiContracts, {
  method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';
  path: `/api/${string}`;
}>;

export type ApiRouteName = keyof typeof API_ROUTES;

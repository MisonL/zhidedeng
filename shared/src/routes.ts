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
  getAgentStatus: { method: 'GET', path: '/api/agent/status' },
  getMe: { method: 'GET', path: '/api/me' },
  updateMe: { method: 'PATCH', path: '/api/me' },
  checkIn: { method: 'POST', path: '/api/me/checkin' },
  getMyFavorites: { method: 'GET', path: '/api/me/favorites' },
  getMyPosts: { method: 'GET', path: '/api/me/posts' },
  getVendors: { method: 'GET', path: '/api/vendors' },
  getModels: { method: 'GET', path: '/api/models' },
  getModel: { method: 'GET', path: '/api/models/:slug' },
  getStations: { method: 'GET', path: '/api/stations' },
  getStation: { method: 'GET', path: '/api/stations/:slug' },
  getPosts: { method: 'GET', path: '/api/posts' },
  getPost: { method: 'GET', path: '/api/posts/:id' },
  createPost: { method: 'POST', path: '/api/posts' },
  putVote: { method: 'PUT', path: '/api/votes' },
  putFavorite: { method: 'PUT', path: '/api/favorites' },
  getComments: { method: 'GET', path: '/api/comments' },
  createComment: { method: 'POST', path: '/api/comments' },
  getRankings: { method: 'GET', path: '/api/rankings' },
  getBanners: { method: 'GET', path: '/api/banners' },
  search: { method: 'GET', path: '/api/search' },
  getHotSearches: { method: 'GET', path: '/api/hot-searches' },
} as const satisfies Record<keyof ApiContracts, {
  method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE';
  path: `/api/${string}`;
}>;

export type ApiRouteName = keyof typeof API_ROUTES;

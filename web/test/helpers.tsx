import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import App from '../src/App';
import { Providers } from '../src/state';
import { banners, makePost, me, page, rankings, station, vendors } from './fixtures';

export interface StubRequest { url: URL; body: unknown }
type Handler = unknown | ((req: StubRequest) => unknown);

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function apiError(status: number, code: string, message: string) {
  return json({ error: { code, message } }, status);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const defaults: Record<string, Handler> = {
  'GET /api/me': me,
  'GET /api/me/posts': page([makePost('mine', { title: '我的第一篇分享' })]),
  'GET /api/me/favorites': page([]),
  'GET /api/account/agent-tokens': [],
  'GET /api/vendors': page(vendors),
  'GET /api/stations': page([station]),
  'GET /api/models': page(vendors.flatMap((vendor) => vendor.models)),
  'GET /api/banners': page(banners),
  'GET /api/hot-searches': page(['DeepSeek', 'Claude']),
  'GET /api/posts': page([makePost('p1'), makePost('p2')]),
  'GET /api/comments': page([]),
  'GET /api/rankings': ({ url }: StubRequest) => rankings(url.searchParams.get('tab') as 'model'),
};

/** 用路由表替换全局 fetch；处理器可返回数据、Response、或 Promise。 */
export function stubApi(routes: Record<string, Handler> = {}) {
  const table = { ...defaults, ...routes };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (!(key in table)) return apiError(404, 'NOT_FOUND', `未桩接口 ${key}`);
    const handler = table[key];
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const result = await (typeof handler === 'function' ? handler({ url, body }) : handler);
    return result instanceof Response ? result : json(result);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function callsTo(fetchMock: ReturnType<typeof stubApi>, method: string, pathname: string) {
  return fetchMock.mock.calls
    .filter(([input, init]) => (init?.method ?? 'GET') === method && new URL(input, 'http://localhost').pathname === pathname)
    .map(([input, init]) => ({
      url: new URL(input, 'http://localhost'),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    }));
}

export function renderWithProviders(ui: ReactElement, route = '/') {
  return render(<MemoryRouter initialEntries={[route]}><Providers>{ui}</Providers></MemoryRouter>);
}

export function renderApp(route = '/') {
  return renderWithProviders(<App />, route);
}

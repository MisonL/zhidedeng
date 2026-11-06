import { useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import type { PaginatedResponse } from '@zhidedeng/shared';

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  reload: () => void;
}

/** 取数并管理加载/错误态；deps 变化或 reload 时重新请求，并中止上一次请求。 */
export function useAsync<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({});
    fetcher(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ data }); },
      (error: Error) => { if (!controller.signal.aborted) setState({ error }); },
    );
    return () => controller.abort();
    // 请求由调用方的 deps 决定，fetcher 每次渲染都是新函数，不参与依赖。
  }, [...deps, attempt]);

  return {
    ...state,
    reload: () => setAttempt((value) => value + 1),
    setData: (data: T) => setState({ data }),
  };
}

/** 分页列表：首屏走三态，加载更多追加，失败时保留已有内容。 */
export function usePaged<T>(
  fetchPage: (page: number, signal?: AbortSignal) => Promise<PaginatedResponse<T>>,
  deps: DependencyList,
) {
  const first = useAsync((signal) => fetchPage(1, signal), deps);
  const [more, setMore] = useState<{ source?: unknown; items: T[]; page: number }>({ items: [], page: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<{ source?: unknown; error: Error }>();

  // 换了筛选条件后，上一批的追加内容作废。
  const extra = more.source === first.data ? more : { items: [], page: 1 };
  const data = first.data && [...first.data.items, ...extra.items];
  const source = useRef(first.data);
  source.current = first.data;

  const loadMore = async () => {
    const origin = first.data;
    setLoadingMore(true);
    setMoreFailure(undefined);
    try {
      const next = await fetchPage(extra.page + 1);
      if (source.current === origin) {
        setMore({ source: origin, items: [...extra.items, ...next.items], page: extra.page + 1 });
      }
    } catch (error) {
      if (source.current === origin) setMoreFailure({ source: origin, error: error as Error });
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    data,
    error: first.error,
    reload: first.reload,
    hasMore: first.data !== undefined && data!.length < first.data.total,
    loadingMore,
    moreError: moreFailure?.source === first.data ? moreFailure?.error : undefined,
    loadMore,
  };
}

/** Banner 与小轮播共用：自动播放、悬停暂停；用户偏好减少动效时不自动切换。 */
export function useCarousel(count: number, intervalMs: number) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || count < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % count), intervalMs);
    return () => window.clearInterval(timer);
  }, [paused, count, intervalMs, index]);

  return {
    index,
    goTo: setIndex,
    next: () => setIndex((value) => (value + 1) % count),
    prev: () => setIndex((value) => (value - 1 + count) % count),
    hoverProps: {
      onMouseEnter: () => setPaused(true),
      onMouseLeave: () => setPaused(false),
      onFocus: () => setPaused(true),
      onBlur: () => setPaused(false),
    },
  };
}

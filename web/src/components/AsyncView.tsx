import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true">
      <span className="sr-only">加载中</span>
      {Array.from({ length: rows }, (_, index) => <span key={index} className="skeleton-row" />)}
    </div>
  );
}

export function Empty({ title = '这里还没有内容', action }: { title?: string; action?: { to: string; label: string } }) {
  return (
    <div className="state">
      <p>{title}</p>
      {action && <Link className="btn btn-ghost" to={action.to}>{action.label}</Link>}
    </div>
  );
}

interface AsyncViewProps<T> {
  state: { data?: T; error?: Error; reload: () => void };
  isEmpty?: (data: T) => boolean;
  skeleton?: ReactNode;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/** 统一的加载、空、错误三态。 */
export default function AsyncView<T>({ state, isEmpty, skeleton, empty, children }: AsyncViewProps<T>) {
  if (state.error) {
    return (
      <div className="state state-error">
        <p>{state.error.message}</p>
        <button type="button" className="btn btn-ghost" onClick={state.reload}>重试</button>
      </div>
    );
  }
  if (state.data === undefined) return skeleton ?? <Skeleton />;
  if (isEmpty?.(state.data)) return empty ?? <Empty />;
  return children(state.data);
}

/** 分页列表底部：加载更多及其错误提示。 */
export function LoadMore({ paged }: {
  paged: { hasMore: boolean; loadingMore: boolean; moreError?: Error; loadMore: () => void };
}) {
  if (!paged.hasMore) return null;
  return (
    <div className="load-more">
      {paged.moreError && <p className="form-error">{paged.moreError.message}</p>}
      <button type="button" className="btn btn-ghost" disabled={paged.loadingMore} onClick={paged.loadMore}>
        {paged.loadingMore ? '加载中…' : '加载更多'}
      </button>
    </div>
  );
}

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
export default function AsyncView<T>({ state, isEmpty, skeleton, empty: emptyFallback, children }: AsyncViewProps<T>) {
  if (state.error) {
    return (
      <div className="state state-error">
        <p>{state.error.message}</p>
        <button type="button" className="btn btn-ghost" onClick={state.reload}>重试</button>
      </div>
    );
  }
  if (state.data === undefined) return skeleton ?? <Skeleton />;
  // 数组默认按「空即空态」处理。原先只有显式传 isEmpty 才算空，于是 `[]` 会被当成
  // 有数据、children 照常执行，里面的 items[0].id 直接抛 TypeError——
  // 新部署站点还没审核通过的文章时，首页、社区、评测三页会一起白屏。
  const empty = isEmpty ? isEmpty(state.data) : Array.isArray(state.data) && state.data.length === 0;
  if (empty) return emptyFallback ?? <Empty />;
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

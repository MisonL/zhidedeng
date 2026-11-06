import { useState } from 'react';
import { Link } from 'react-router';
import type { PostKind, PostSort } from '@zhidedeng/shared';
import { api } from '../api';
import { formatRate, formatUptime, KIND_LABEL } from '../format';
import { useAsync, useCarousel, usePaged } from '../hooks';
import { useCatalog } from '../state';
import AsyncView, { LoadMore, Skeleton } from './AsyncView';
import PostCard from './PostCard';
import { PostCover } from './visuals';

const FEED_KINDS: PostKind[] = ['deal', 'review', 'guide', 'community'];
const SORTS: { value: PostSort; label: string }[] = [{ value: 'latest', label: '最新' }, { value: 'hot', label: '最热' }];

interface FeedProps {
  title: string;
  heading?: 'h1' | 'h2';
  /** 固定类型时隐藏类型切换。 */
  kind?: PostKind;
}

export default function Feed({ title, heading: Heading = 'h2', kind: fixedKind }: FeedProps) {
  const [ownKind, setOwnKind] = useState<PostKind>('deal');
  const [sort, setSort] = useState<PostSort>('latest');
  const [vendor, setVendor] = useState('');
  const { data: catalog } = useCatalog();
  const kind = fixedKind ?? ownKind;
  const paged = usePaged(
    (page, signal) => api.getPosts({ kind, sort, vendor, page, pageSize: 10 }, signal),
    [kind, sort, vendor],
  );

  return (
    <section className="module" aria-label={title}>
      <header className="feed-head">
        <Heading className="feed-title">{title}</Heading>
        {!fixedKind && (
          <div className="segmented">
            {FEED_KINDS.map((value) => (
              <button key={value} type="button" className="segment" aria-pressed={value === kind} onClick={() => setOwnKind(value)}>
                {KIND_LABEL[value]}
              </button>
            ))}
          </div>
        )}
        <div className="feed-filters">
          <select aria-label="按厂商筛选" value={vendor} onChange={(event) => setVendor(event.target.value)}>
            <option value="">全部厂商</option>
            {catalog?.vendors.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
          </select>
          {SORTS.map(({ value, label }) => (
            <button key={value} type="button" className="text-toggle" aria-pressed={value === sort} onClick={() => setSort(value)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      <AsyncView state={paged} isEmpty={(items) => items.length === 0} skeleton={<div className="feed-skeleton"><Skeleton rows={6} /></div>}>
        {(items) => <div className="card-list">{items.map((post) => <PostCard key={post.id} post={post} />)}</div>}
      </AsyncView>
      <LoadMore paged={paged} />
    </section>
  );
}

export function FeedSidebar() {
  const hot = useAsync((signal) => api.getPosts({ sort: 'hot', page: 1, pageSize: 6 }, signal), []);
  const featuredCount = Math.min(hot.data?.items.length ?? 0, 3);
  const { index, goTo, hoverProps } = useCarousel(featuredCount, 6000);
  const catalog = useCatalog();
  // 接口已按综合得分排好（无分数的站点在后）。
  const stations = (catalog.data?.stations ?? []).slice(0, 5);

  return (
    <aside className="feed-side">
      <section className="module side-block" aria-label="热门文章" {...hoverProps}>
        <header className="side-head">
          <h2 className="side-title">热门文章</h2>
          <div className="mini-dots">
            {Array.from({ length: featuredCount }, (_, slide) => (
              <button key={slide} type="button" className="mini-dot" aria-label={`第 ${slide + 1} 篇热门`} aria-current={slide === index} onClick={() => goTo(slide)} />
            ))}
          </div>
        </header>
        <AsyncView state={{ data: hot.data?.items, error: hot.error, reload: hot.reload }}>
          {(items) => (
            <>
              <Link key={items[index].id} className="side-feature" to={`/posts/${items[index].id}`}>
                <span className="side-feature-art"><PostCover post={items[index]} /></span>
                <span className="side-feature-title">{items[index].title}</span>
              </Link>
              <ol className="side-list">
                {items.filter((_, position) => position !== index).map((post) => (
                  <li key={post.id}><Link to={`/posts/${post.id}`}>{post.title}</Link></li>
                ))}
              </ol>
            </>
          )}
        </AsyncView>
      </section>
      <section className="module side-block" aria-label="热门中转站">
        <header className="side-head">
          <h2 className="side-title">热门中转站</h2>
          <Link className="module-more" to="/stations">全部站点</Link>
        </header>
        <AsyncView state={catalog}>
          {() => (
            <ol className="side-stations">
              {stations.map((station, position) => (
                <li key={station.slug}>
                  <Link to={`/stations/${station.slug}`}>
                    <span className="side-rank num">{position + 1}</span>
                    <span className="side-station-name">{station.name}</span>
                    {station.lowestRate !== null && <span className="side-station-rate num">{formatRate(station.lowestRate)}</span>}
                    <span className="side-station-uptime num">{formatUptime(station.uptime)}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </AsyncView>
      </section>
    </aside>
  );
}

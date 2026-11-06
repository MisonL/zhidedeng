import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { StationSort } from '@zhidedeng/shared';
import { api } from '../api';
import AsyncView, { Empty, LoadMore } from '../components/AsyncView';
import Comments from '../components/Comments';
import FavoriteButton from '../components/FavoriteButton';
import PostCard from '../components/PostCard';
import StationCard from '../components/StationCard';
import { StationTile } from '../components/visuals';
import VoteButtons from '../components/VoteButtons';
import { DISCLAIMER, formatLatency, formatRate, formatStatus, formatUptime, NOT_AVAILABLE, SITE_NOTICE, SUBMISSION_LABEL } from '../format';
import { useAsync, usePaged } from '../hooks';
import { useCatalog } from '../state';

const SORTS: { value: StationSort; label: string }[] = [
  { value: 'score', label: '综合' },
  { value: 'rate', label: '倍率' },
  { value: 'uptime', label: '可用率' },
];

export function Stations() {
  const [params, setParams] = useSearchParams();
  const vendor = params.get('vendor') ?? '';
  const requestedSort = params.get('sort');
  const sort = SORTS.find(({ value }) => value === requestedSort)?.value ?? 'score';
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const { data: catalog } = useCatalog();
  const paged = usePaged(
    (page, signal) => api.getStations({ vendor, sort, q, page, pageSize: 10 }, signal),
    [vendor, sort, q],
  );

  useEffect(() => setDraft(q), [q]);

  function update(next: { vendor?: string; sort?: StationSort; q?: string }) {
    const merged = { vendor, sort, q, ...next };
    setParams(Object.fromEntries(Object.entries(merged).filter(([, value]) => value)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    update({ q: draft.trim() });
  }

  return (
    <section className="module page">
      <title>中转站库 · 什么值得蹬</title>
      <header className="page-head">
        <h1 className="page-title">中转站库</h1>
        <p className="page-sub">{SITE_NOTICE}。</p>
      </header>
      <div className="filter-bar">
        <div className="segmented">
          {SORTS.map(({ value, label }) => (
            <button key={value} type="button" className="segment" aria-pressed={value === sort} onClick={() => update({ sort: value })}>{label}</button>
          ))}
        </div>
        <select aria-label="按厂商筛选" value={vendor} onChange={(event) => update({ vendor: event.target.value })}>
          <option value="">全部厂商</option>
          {catalog?.vendors.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
        </select>
        <form className="inline-search" onSubmit={submit}>
          <input aria-label="筛选中转站" placeholder="按名称筛选站点" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="btn btn-ghost">筛选</button>
        </form>
      </div>
      <AsyncView state={paged} isEmpty={(items) => items.length === 0} empty={<Empty title="没有符合条件的中转站" />}>
        {(items) => <div className="card-list">{items.map((station) => <StationCard key={station.slug} station={station} />)}</div>}
      </AsyncView>
      <LoadMore paged={paged} />
    </section>
  );
}

export function StationDetailPage() {
  const { slug = '' } = useParams();
  const state = useAsync((signal) => api.getStation(slug, signal), [slug]);
  const posts = useAsync((signal) => api.getPosts({ station: slug, pageSize: 5 }, signal), [slug]);
  const { vendorBySlug } = useCatalog();

  return (
    <>
      <title>{`${state.data?.name ?? '中转站详情'} · 什么值得蹬`}</title>
      {state.data && <p className="demo-notice" role="note">{state.data.source === 'submission' ? `${SUBMISSION_LABEL}，不构成消费建议` : DISCLAIMER}</p>}
      <section className="module page">
        <AsyncView state={state}>
          {(station) => (
            <>
              <header className="page-head station-head">
                <span className="station-art"><StationTile station={station} /></span>
                <div className="station-head-main">
                  <h1 className="page-title">{station.name}</h1>
                  <p className="page-sub">{station.description}</p>
                  <div className="station-actions">
                    <VoteButtons targetType="station" targetId={station.slug} votes={station.votes} currentUserVote={station.currentUserVote} />
                    <FavoriteButton targetType="station" targetId={station.slug} favorited={station.favorited} favoriteCount={station.favoriteCount} />
                  </div>
                </div>
              </header>
              <dl className="metrics">
                <div><dt>最低倍率</dt><dd className="num is-accent">{station.lowestRate === null ? '暂无' : `低至 ${formatRate(station.lowestRate)}`}</dd></div>
                {station.url && <div><dt>站点网址</dt><dd><a href={station.url} target="_blank" rel="nofollow noopener noreferrer">{station.url}</a></dd></div>}
                <div><dt>可用率</dt><dd className="num">{formatUptime(station.uptime)}</dd></div>
                <div><dt>首 token 延迟</dt><dd className="num">{formatLatency(station.firstTokenLatencyMs)}</dd></div>
                <div><dt>充值门槛</dt><dd className="num">{station.rechargeThreshold === null ? NOT_AVAILABLE : `${station.rechargeThreshold} 元起`}</dd></div>
                <div><dt>支付方式</dt><dd>{station.paymentMethods.join('、') || NOT_AVAILABLE}</dd></div>
                <div><dt>成立时间</dt><dd className="num">{station.foundedAt?.slice(0, 7) ?? NOT_AVAILABLE}</dd></div>
                <div><dt>运行状态</dt><dd>{formatStatus(station.status)}</dd></div>
                <div><dt>综合得分</dt><dd className="num">{station.score ?? NOT_AVAILABLE}</dd></div>
              </dl>
              <h2 className="section-title">模型倍率</h2>
              <div className="table-scroll">
                <table className="data-table data-table-compact">
                  <thead><tr><th>模型</th><th>厂商</th><th>倍率</th></tr></thead>
                  <tbody>
                    {station.offers.map((offer) => (
                      <tr key={offer.modelSlug}>
                        <td><Link to={`/models/${offer.modelSlug}`}>{offer.model.name}</Link></td>
                        <td>{vendorBySlug.get(offer.model.vendor)?.name}</td>
                        <td className="num rate-cell">{formatRate(offer.rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </AsyncView>
      </section>
      {state.data && <Comments targetType="station" targetId={slug} />}
      <section className="module page" aria-label="相关文章">
        <h2 className="section-title">相关文章</h2>
        <AsyncView
          state={{ data: posts.data?.items, error: posts.error, reload: posts.reload }}
          isEmpty={(items) => items.length === 0}
          empty={<Empty title="暂无相关文章" />}
        >
          {(items) => <div className="card-list">{items.map((post) => <PostCard key={post.id} post={post} />)}</div>}
        </AsyncView>
      </section>
    </>
  );
}

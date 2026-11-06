import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api';
import AsyncView, { Empty, LoadMore } from '../components/AsyncView';
import PostCard from '../components/PostCard';
import { VendorIcon } from '../components/visuals';
import { formatLatency, formatRate, formatStatus, formatUptime, SUBMISSION_LABEL } from '../format';
import { useAsync, usePaged } from '../hooks';
import { useCatalog } from '../state';

export function Models() {
  const [params, setParams] = useSearchParams();
  const vendor = params.get('vendor') ?? '';
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const { data: catalog, vendorBySlug } = useCatalog();
  const paged = usePaged(
    (page, signal) => api.getModels({ vendor, q, page, pageSize: 24 }, signal),
    [vendor, q],
  );

  useEffect(() => setDraft(q), [q]);

  function update(next: { vendor?: string; q?: string }) {
    const merged = { vendor, q, ...next };
    setParams(Object.fromEntries(Object.entries(merged).filter(([, value]) => value)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    update({ q: draft.trim() });
  }

  return (
    <section className="module page">
      <title>模型库 · 什么值得蹬</title>
      <header className="page-head">
        <h1 className="page-title">模型库</h1>
        <p className="page-sub">按厂商看模型，进详情比较各中转站的相对倍率。想直接看站点？去 <Link to="/stations">中转站库</Link>。</p>
      </header>
      <div className="chip-row" role="group" aria-label="按厂商筛选">
        <button type="button" className="chip" aria-pressed={!vendor} onClick={() => update({ vendor: '' })}>全部</button>
        {catalog?.vendors.map((item) => (
          <button key={item.slug} type="button" className="chip" aria-pressed={item.slug === vendor} onClick={() => update({ vendor: item.slug })}>
            <VendorIcon iconKey={item.iconKey} size={16} />{item.name}
          </button>
        ))}
      </div>
      <form className="inline-search" onSubmit={submit}>
        <input aria-label="筛选模型" placeholder="按名称筛选模型" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="btn btn-ghost">筛选</button>
      </form>
      <AsyncView state={paged} isEmpty={(items) => items.length === 0} empty={<Empty title="没有符合条件的模型" />}>
        {(items) => (
          <ul className="model-grid">
            {items.map((model) => {
              const owner = vendorBySlug.get(model.vendor);
              return (
                <li key={model.slug}>
                  <Link className="model-card" to={`/models/${model.slug}`}>
                    <span className="model-card-head">
                      {owner && <VendorIcon iconKey={owner.iconKey} size={28} />}
                      <strong>{model.name}</strong>
                    </span>
                    <span className="model-card-desc">{model.description}</span>
                    <span className="tags">{model.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </section>
  );
}

export function ModelDetailPage() {
  const { slug = '' } = useParams();
  const state = useAsync((signal) => api.getModel(slug, signal), [slug]);
  const posts = useAsync((signal) => api.getPosts({ model: slug, pageSize: 5 }, signal), [slug]);
  const { vendorBySlug } = useCatalog();

  return (
    <>
      <title>{`${state.data?.name ?? '模型详情'} · 什么值得蹬`}</title>
      <section className="module page">
        <AsyncView state={state}>
          {(model) => {
            const owner = vendorBySlug.get(model.vendor);
            return (
              <>
                <header className="page-head detail-head">
                  {owner && <VendorIcon iconKey={owner.iconKey} size={44} />}
                  <div>
                    <h1 className="page-title">{model.name}</h1>
                    <p className="page-sub">{owner?.name} · {model.description}</p>
                    <div className="tags">{model.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}</div>
                  </div>
                </header>
                <h2 className="section-title">各中转站倍率比价</h2>
                <p className="hint">倍率为相对官方价的系数，数字越小越便宜。</p>
                {model.offers.length === 0
                  ? <Empty title="暂时没有站点报价" />
                  : (
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead><tr><th>中转站</th><th>倍率</th><th>可用率</th><th>首 token 延迟</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead>
                        <tbody>
                          {model.offers.map((offer) => (
                            <tr key={offer.stationSlug} className={offer.rate === model.offers[0].rate ? 'is-best' : undefined}>
                              <td>
                                <Link to={`/stations/${offer.stationSlug}`}>{offer.station.name}</Link>{' '}
                                {offer.station.source === 'submission' && <span className="tag tag-warn">{SUBMISSION_LABEL}</span>}
                              </td>
                              <td className="num rate-cell">{formatRate(offer.rate)}</td>
                              <td className="num">{formatUptime(offer.station.uptime)}</td>
                              <td className="num">{formatLatency(offer.station.firstTokenLatencyMs)}</td>
                              <td>{formatStatus(offer.station.status)}</td>
                              <td><Link className="btn btn-red btn-small" to={`/stations/${offer.stationSlug}`}>去看看</Link></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </>
            );
          }}
        </AsyncView>
      </section>
      <section className="module page" aria-label="相关文章">
        <h2 className="section-title">相关文章</h2>
        <AsyncView
          state={{ data: posts.data?.items, error: posts.error, reload: posts.reload }}
          isEmpty={(items) => items.length === 0}
          empty={<Empty title="暂无相关文章" action={{ to: '/submit?kind=review', label: '写一篇评测' }} />}
        >
          {(items) => <div className="card-list">{items.map((post) => <PostCard key={post.id} post={post} />)}</div>}
        </AsyncView>
      </section>
    </>
  );
}

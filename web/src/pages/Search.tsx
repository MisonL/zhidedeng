import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import AsyncView, { Empty } from '../components/AsyncView';
import PostCard from '../components/PostCard';
import StationCard from '../components/StationCard';
import { VendorIcon } from '../components/visuals';
import { useAsync } from '../hooks';
import { useCatalog } from '../state';

function SearchResults({ q }: { q: string }) {
  const state = useAsync((signal) => api.search(q, signal), [q]);
  const { vendorBySlug } = useCatalog();

  return (
    <AsyncView
      state={state}
      isEmpty={({ models, stations, posts }) => models.length + stations.length + posts.length === 0}
      empty={<section className="module page"><Empty title={`没有找到与“${q}”相关的内容`} /></section>}
    >
      {({ models, stations, posts }) => (
        <>
          {models.length > 0 && (
            <section className="module page" aria-labelledby="result-models">
              <h2 className="section-title" id="result-models">模型 <span className="num hint">{models.length}</span></h2>
              <ul className="model-grid">
                {models.map((model) => {
                  const owner = vendorBySlug.get(model.vendor);
                  return (
                    <li key={model.slug}>
                      <Link className="model-card" to={`/models/${model.slug}`}>
                        <span className="model-card-head">
                          {owner && <VendorIcon iconKey={owner.iconKey} size={28} />}
                          <strong>{model.name}</strong>
                        </span>
                        <span className="model-card-desc">{model.description}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {stations.length > 0 && (
            <section className="module page" aria-labelledby="result-stations">
              <h2 className="section-title" id="result-stations">中转站 <span className="num hint">{stations.length}</span></h2>
              <div className="card-list">{stations.map((station) => <StationCard key={station.slug} station={station} />)}</div>
            </section>
          )}
          {posts.length > 0 && (
            <section className="module page" aria-labelledby="result-posts">
              <h2 className="section-title" id="result-posts">文章 <span className="num hint">{posts.length}</span></h2>
              <div className="card-list">{posts.map((post) => <PostCard key={post.id} post={post} />)}</div>
            </section>
          )}
        </>
      )}
    </AsyncView>
  );
}

export default function Search() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();

  return (
    <>
      <title>{`${q ? `${q} 的搜索结果` : '搜索'} · 什么值得蹬`}</title>
      <header className="module page search-head">
        <h1 className="page-title">{q ? `“${q}”的搜索结果` : '搜索结果'}</h1>
        {!q && <p className="page-sub">在顶部搜索框输入模型、厂商或中转站。</p>}
      </header>
      {q && <SearchResults q={q} />}
    </>
  );
}

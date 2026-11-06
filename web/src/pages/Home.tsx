import { Link } from 'react-router';
import { api } from '../api';
import AsyncView, { Skeleton } from '../components/AsyncView';
import BannerCarousel from '../components/BannerCarousel';
import Feed, { FeedSidebar } from '../components/Feed';
import Icon from '../components/Icon';
import RankingBoard from '../components/RankingBoard';
import UserCard from '../components/UserCard';
import { VendorIcon } from '../components/visuals';
import { useAsync } from '../hooks';
import { useCatalog } from '../state';

function VendorNav() {
  const catalog = useCatalog();
  return (
    <nav className="vendor-nav" aria-label="厂商">
      <AsyncView state={catalog} skeleton={<Skeleton rows={8} />}>
        {(data) => (
          <ul className="vendor-list">
            {data.vendors.map((vendor) => (
              <li key={vendor.slug} className="vendor-item">
                <Link className="vendor-link" to={`/models?vendor=${vendor.slug}`}>
                  <VendorIcon iconKey={vendor.iconKey} />
                  <span className="vendor-name">{vendor.name}</span>
                  <Icon name="right" size={14} />
                </Link>
                <div className="vendor-flyout">
                  <p className="vendor-flyout-title">{vendor.name} 模型</p>
                  <ul className="vendor-models">
                    {vendor.models.map((model) => (
                      <li key={model.slug}>
                        <Link to={`/models/${model.slug}`}>
                          <strong>{model.name}</strong>
                          <span>{model.description}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </nav>
  );
}

function BannerSection() {
  const state = useAsync((signal) => api.getBanners(signal), []);
  return (
    <div className="banner-frame">
      <AsyncView
        state={{ data: state.data?.items, error: state.error, reload: state.reload }}
        skeleton={<div className="banner-placeholder" aria-busy="true"><span className="sr-only">加载中</span></div>}
      >
        {(items) => <BannerCarousel banners={items} />}
      </AsyncView>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <title>什么值得蹬</title>
      <h1 className="sr-only">什么值得蹬：我们的AI中转指南</h1>
      <div className="hero-grid">
        <VendorNav />
        <BannerSection />
        <UserCard />
      </div>
      <RankingBoard />
      <div className="feed-layout">
        <Feed title="值得蹬" />
        <FeedSidebar />
      </div>
    </>
  );
}

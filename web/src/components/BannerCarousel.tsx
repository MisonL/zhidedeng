import { Link } from 'react-router';
import type { Banner } from '@zhidedeng/shared';
import { useCarousel } from '../hooks';
import { useCatalog } from '../state';
import Icon from './Icon';
import { VendorIcon } from './visuals';

export default function BannerCarousel({ banners }: { banners: Banner[] }) {
  const { index, goTo, next, prev, hoverProps } = useCarousel(banners.length, 5000);
  const { data: catalog } = useCatalog();

  return (
    <section className="banner" aria-label="首页推荐" {...hoverProps}>
      {banners.map((banner, slide) => {
        const active = slide === index;
        const vendor = catalog?.vendors.find((item) => `${banner.title} ${banner.description}`.includes(item.name));
        return (
          <div key={banner.id} className={`banner-slide art-${banner.id}${active ? ' is-active' : ''}`} aria-hidden={!active} inert={!active}>
            <img className="banner-image" src={banner.image} alt="" />
            <div className="banner-copy">
              {vendor && (
                <span className="banner-vendor">
                  <VendorIcon iconKey={vendor.iconKey} size={26} />{vendor.name}
                </span>
              )}
              <h2 className="banner-title">{banner.title}</h2>
              <p className="banner-desc">{banner.description}</p>
              <span className="banner-pill">{banner.href.startsWith('/stations') ? '中转站导购' : '精选好文'}</span>
              <Link className="banner-cta" to={banner.href}>立即查看<Icon name="right" size={18} /></Link>
            </div>
          </div>
        );
      })}
      <button type="button" className="banner-arrow banner-prev" aria-label="上一张" onClick={prev}><Icon name="left" size={20} /></button>
      <button type="button" className="banner-arrow banner-next" aria-label="下一张" onClick={next}><Icon name="right" size={20} /></button>
      <div className="banner-dots">
        {banners.map((banner, slide) => (
          <button
            key={banner.id} type="button" className="banner-dot" aria-label={`第 ${slide + 1} 张`}
            aria-current={slide === index} onClick={() => goTo(slide)}
          />
        ))}
      </div>
    </section>
  );
}

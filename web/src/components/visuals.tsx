import type { CSSProperties } from 'react';
import type { Model, Post, Station } from '@zhidedeng/shared';
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg';
import doubao from '@lobehub/icons-static-svg/icons/doubao-color.svg';
import google from '@lobehub/icons-static-svg/icons/google-color.svg';
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg';
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg';
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg';
import openai from '@lobehub/icons-static-svg/icons/openai.svg';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg';
import xai from '@lobehub/icons-static-svg/icons/xai.svg';
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg';
import { formatLatency, formatRate, NOT_AVAILABLE } from '../format';
import { useCatalog } from '../state';

// 厂商图标仅作分类标识；tint 是封面底色，deep 是同色系的深色，用于水印和纹理。
const VENDOR_ART: Record<string, { src: string; tint: string; deep: string }> = {
  openai: { src: openai, tint: '#DDEFE7', deep: '#0F8F6E' },
  anthropic: { src: anthropic, tint: '#F5E6DA', deep: '#C2623B' },
  google: { src: google, tint: '#E4EDFB', deep: '#3B7DED' },
  deepseek: { src: deepseek, tint: '#DFE7FB', deep: '#4D6BFE' },
  xai: { src: xai, tint: '#E8E8E6', deep: '#5B6470' },
  meta: { src: meta, tint: '#DCEBFC', deep: '#0668E1' },
  qwen: { src: qwen, tint: '#EAE4FB', deep: '#615CED' },
  doubao: { src: doubao, tint: '#DDEFF9', deep: '#1E9BD7' },
  moonshot: { src: moonshot, tint: '#E6E6EA', deep: '#4B5A8A' },
  zhipu: { src: zhipu, tint: '#DEE8FB', deep: '#3859FF' },
  minimax: { src: minimax, tint: '#FBE3E7', deep: '#E2455F' },
};
const SEAL_ART = { tint: '#F8E7DF', deep: '#E62828' };
/** 新增厂商的 iconKey 可能还没有内置图标，用站内图标兜底，不能让页面崩掉。 */
const FALLBACK_ICON = '/favicon.svg';
// 用 hasOwn 查表，避免 iconKey 为 constructor 等原型链属性名时返回 Object 而不是兜底。
const VENDOR_ART_OR_FALLBACK = (iconKey: string) => Object.hasOwn(VENDOR_ART, iconKey) ? VENDOR_ART[iconKey] : { src: FALLBACK_ICON, tint: SEAL_ART.tint, deep: SEAL_ART.deep };

const ACCENTS = ['#E62828', '#D9722B', '#2F7D6B', '#2F5BE3', '#7A4FC9', '#B8407A', '#1F8FB3', '#8A6A1F'];

function hashIndex(text: string, size: number) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) % 9973;
  return hash % size;
}

const accentOf = (name: string) => ACCENTS[hashIndex(name, ACCENTS.length)];
/** 演示数据的名称都带「虚构」前缀，取其后的首字，头像和封面才不会全是同一个字；前缀后没有内容就用原名首字。 */
const glyphOf = (name: string) => [...(name.replace(/^虚构·?/, '') || name)][0];

export function VendorIcon({ iconKey, size = 20 }: { iconKey: string; size?: number }) {
  return <img className="vendor-icon" src={VENDOR_ART_OR_FALLBACK(iconKey).src} alt="" width={size} height={size} />;
}

export function Avatar({ nickname, size = 32 }: { nickname: string; size?: number }) {
  return (
    <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.45, background: accentOf(nickname) }}>
      {glyphOf(nickname)}
    </span>
  );
}

// 以下封面都是纯装饰：对读屏隐藏，文字放在 data-* 里由 CSS attr() 画出，不进入 DOM 文本。

/** 模型封面：厂商色底 + 按模型名取的纹理 + 模型名水印 + 图标徽章。 */
export function ModelTile({ model }: { model: Pick<Model, 'vendor' | 'name'> }) {
  const vendor = useCatalog().vendorBySlug.get(model.vendor);
  const art = vendor ? VENDOR_ART_OR_FALLBACK(vendor.iconKey) : SEAL_ART;
  return (
    <span
      className={`cover cover-model pat-${hashIndex(model.name, 4)}`} aria-hidden="true" data-mark={model.name}
      style={{ '--tint': art.tint, '--deep': art.deep } as CSSProperties}
    >
      <span className="cover-badge">
        {vendor ? <VendorIcon iconKey={vendor.iconKey} size={56} /> : <img src="/favicon.svg" alt="" />}
      </span>
    </span>
  );
}

/** 文章封面按类型区分：爆料是倍率票券，评测是可用率仪表，指南是书封，社区是气泡引语。 */
export function PostCover({ post }: { post: Post }) {
  const { modelBySlug, stationBySlug, vendorBySlug } = useCatalog();
  const model = post.modelSlug ? modelBySlug.get(post.modelSlug) : undefined;
  const station = post.stationSlug ? stationBySlug.get(post.stationSlug) : undefined;
  const vendor = model && vendorBySlug.get(model.vendor);
  const art = vendor ? VENDOR_ART_OR_FALLBACK(vendor.iconKey) : SEAL_ART;
  // 种子文章标题是「站名 · 标题」，封面只留标题；用户自己写的间隔号不动。
  const seedPrefix = station ? `${station.name.replace(/^虚构·/, '')} · ` : '';
  const pitch = <span className="cover-pitch" data-pitch={post.title.startsWith(seedPrefix) ? post.title.slice(seedPrefix.length) : post.title} />;
  const seal = <img className="cover-seal" src="/favicon.svg" alt="" />;
  const foot = model && (
    <span className="cover-foot" data-label={model.name}>{vendor && <VendorIcon iconKey={vendor.iconKey} size={14} />}</span>
  );
  const body = {
    deal: (
      <span className="cover-ticket">
        {station?.lowestRate != null
          ? <span className="cover-figure"><span className="cover-value" data-value={station.lowestRate} data-unit="x" /></span>
          : seal}
        {foot}
      </span>
    ),
    review: (
      <>
        {station ? (
          <>
            {/* 仪表从 90% 起算，否则各站都接近满圈；确切数值写在圈内。 */}
            <span className="cover-gauge" style={{ '--p': station.uptime === null ? 0 : Math.max(0, station.uptime - 90) * 10 } as CSSProperties}>
              {station.uptime === null
                ? <span className="cover-value" data-value={NOT_AVAILABLE} />
                : <span className="cover-value" data-value={station.uptime} data-unit="%" />}
            </span>
            <span className="cover-meter" data-value={`首 token ${formatLatency(station.firstTokenLatencyMs)}`} />
          </>
        ) : seal}
        {foot}
      </>
    ),
    guide: <>{pitch}{foot}{seal}</>,
    community: (
      <>
        {pitch}
        <span className="cover-foot" data-glyph={glyphOf(post.author.nickname)} data-label={post.author.nickname} />
      </>
    ),
  }[post.kind];

  return (
    <span
      className={`cover cover-${post.kind}`} aria-hidden="true"
      style={{
        '--tint': art.tint, '--deep': art.deep,
        '--accent': accentOf(post.kind === 'deal' && station ? station.name : post.author.nickname),
      } as CSSProperties}
    >
      {body}
    </span>
  );
}

export function StationTile({ station }: { station: Pick<Station, 'name' | 'lowestRate'> }) {
  return (
    <span
      className="cover cover-station" aria-hidden="true" data-glyph={glyphOf(station.name)}
      style={{ '--accent': accentOf(station.name) } as CSSProperties}
    >
      {station.lowestRate !== null && <span className="cover-strip" data-value={formatRate(station.lowestRate)} />}
    </span>
  );
}

export function ExpertTile({ nickname }: { nickname: string }) {
  return (
    <span
      className="cover cover-expert" aria-hidden="true" data-glyph={glyphOf(nickname)}
      style={{ '--accent': accentOf(nickname) } as CSSProperties}
    />
  );
}

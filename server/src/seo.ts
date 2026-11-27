import type { Store } from './database.ts';
import type { PostRecord, Entities } from './database.ts';

/**
 * 服务端 SEO：详情页 meta 注入、sitemap、RSS。
 *
 * 三件事放在一个模块里，因为它们共用同一条规则：**只有真实内容才进索引**。
 * 演示数据是虚构样例，把它塞进 sitemap 等于向搜索引擎承诺不存在的页面；
 * 站内投稿/Agent 采集的内容未经平台核实，正文里可能写着别人的站名，同样不该
 * 被索引成「什么值得蹬对该站的评价」。
 *
 * 域名还没定，所以这里不硬编码任何主机名：`origin` 只在生成绝对 URL
 * （canonical / og:url / sitemap 的 loc）时用到，由调用方传入——生产传
 * PUBLIC_ORIGIN，未配置时退回请求自身的 origin。
 */

export const SITE_NAME = '什么值得蹬';
export const DEFAULT_DESCRIPTION = '中转站与模型的横向对比：倍率、报价口径、可用率都标明来源与时间，没有实测数据的地方一律写「暂无」，不猜。';

export interface SeoMeta {
  title: string;
  description: string;
  /** 站内路径，如 `/stations/x`。拼 canonical / og:url 用。 */
  path: string;
  type: 'website' | 'article';
  /** 不该被索引的页面（演示数据、未核实内容）带 noindex。 */
  noindex?: boolean;
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 详情页的 meta。认不出路径时返回站点级默认值——SPA 自己会渲染 404。 */
export function pageMeta(store: Store, path: string): SeoMeta {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const [section, slug] = segments;

  if (section === 'stations' && slug) {
    const station = store.get('station', decodeURIComponent(slug));
    if (station) {
      const demo = station.source === 'demo';
      return {
        title: `${station.name} · ${SITE_NAME}`,
        description: station.description || `${station.name} 的倍率、报价与可用率。`,
        path: `/stations/${station.slug}`,
        type: 'article',
        // 虚构样例不该被搜索引擎收录：页面本身要能打开（给人看演示），
        // 但不该出现在别人的搜索结果里被当成真实评测。
        ...(demo ? { noindex: true } : {}),
      };
    }
  }

  if (section === 'posts' && slug) {
    const post = store.get('post', decodeURIComponent(slug));
    if (post && post.status === 'approved') {
      return {
        title: `${post.title} · ${SITE_NAME}`,
        description: post.summary || post.body.slice(0, 120),
        path: `/posts/${post.id}`,
        type: 'article',
        // 只有站内用户自己写的文章算「本站在说」；投稿与采集来的照旧可看，
        // 但不进索引（见文件头）。
        ...(post.source === 'user' ? {} : { noindex: true }),
      };
    }
  }

  if (section === 'models' && slug) {
    const model = store.get('model', decodeURIComponent(slug));
    if (model) {
      return {
        title: `${model.name} · ${SITE_NAME}`,
        description: model.description || `${model.name} 在各中转站的报价与倍率对比。`,
        path: `/models/${model.slug}`,
        type: 'article',
      };
    }
  }

  return { title: SITE_NAME, description: DEFAULT_DESCRIPTION, path: '/', type: 'website' };
}

/**
 * 把 meta 注入 index.html。
 *
 * 不用模板引擎：构建产物里只有一个 `<title>` 和一条 description，都是
 * 一次性的字符串替换。注入点靠 `</head>` 定位，页面结构改了也不会炸。
 * 两条 meta（description / robots）先删后插，避免同一个名字出现两次——
 * 重复的 meta 里浏览器取第一个，删掉重建比「找到再改」更不容易漏。
 */
export function injectMeta(html: string, meta: SeoMeta, origin: string): string {
  const url = `${origin.replace(/\/$/, '')}${meta.path}`;
  const tags = [
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    ...(meta.noindex ? ['<meta name="robots" content="noindex, follow" />'] : []),
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:type" content="${meta.type}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    '<meta name="twitter:card" content="summary" />',
  ].join('\n    ');

  const stripped = html
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '');
  const titled = stripped.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);
  return /<\/head>/i.test(titled)
    ? titled.replace(/<\/head>/i, `  ${tags}\n  </head>`)
    : titled;
}

/** 进 sitemap 的页面：静态入口 + 真实（非演示）的站点、模型、站内文章。 */
interface SitemapEntry { path: string; lastmod?: string }

export function sitemapEntries(store: Store): SitemapEntry[] {
  const entries: SitemapEntry[] = [
    { path: '/' }, { path: '/stations' }, { path: '/models' }, { path: '/compare' },
    { path: '/community' }, { path: '/reviews' }, { path: '/rank' }, { path: '/docs' },
  ];
  for (const station of store.all('station')) {
    if (station.source === 'demo') continue;
    entries.push({ path: `/stations/${station.slug}` });
  }
  for (const model of store.all('model')) entries.push({ path: `/models/${model.slug}` });
  for (const post of store.all('post')) {
    // 只有 approved 且站内用户写的内容才进索引，理由同 pageMeta。
    if (post.status !== 'approved' || post.source !== 'user') continue;
    entries.push({ path: `/posts/${post.id}`, lastmod: post.publishedAt });
  }
  return entries;
}

export function sitemapXml(store: Store, origin: string): string {
  const base = origin.replace(/\/$/, '');
  const urls = sitemapEntries(store).map(entry =>
    `  <url><loc>${escapeHtml(base + entry.path)}</loc>${entry.lastmod ? `<lastmod>${escapeHtml(entry.lastmod)}</lastmod>` : ''}</url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** RSS 2.0。只收站内用户写的已发布文章，理由同上。 */
export function rssXml(store: Store, origin: string, limit = 30): string {
  const base = origin.replace(/\/$/, '');
  const posts = (store.all('post') as PostRecord[])
    .filter(post => post.status === 'approved' && post.source === 'user')
    .sort((a, b) => (a.publishedAt === b.publishedAt ? 0 : a.publishedAt < b.publishedAt ? 1 : -1))
    .slice(0, limit);
  const items = posts.map(post => [
    '    <item>',
    `      <title>${escapeHtml(post.title)}</title>`,
    `      <link>${escapeHtml(`${base}/posts/${post.id}`)}</link>`,
    `      <guid isPermaLink="true">${escapeHtml(`${base}/posts/${post.id}`)}</guid>`,
    `      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>`,
    `      <description>${escapeHtml(post.summary || post.body.slice(0, 200))}</description>`,
    '    </item>',
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeHtml(SITE_NAME)}</title>`,
    `    <link>${escapeHtml(base)}</link>`,
    `    <description>${escapeHtml(DEFAULT_DESCRIPTION)}</description>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

/** robots.txt：后台与接口不抓，其余放行，并指出 sitemap。 */
export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /api/',
    'Allow: /',
    '',
    `Sitemap: ${origin.replace(/\/$/, '')}/sitemap.xml`,
    '',
  ].join('\n');
}

/** 供测试与调用方直接读的类型别名，避免依赖 Entities 的泛型细节。 */
export type StationEntity = Entities['station'];

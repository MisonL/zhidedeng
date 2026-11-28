import type { ContentSource, PostKind, RateBasis, StationStatus } from '@zhidedeng/shared';

export const KIND_LABEL: Record<PostKind, string> = {
  deal: '爆料', review: '评测', community: '社区', guide: '指南',
};

export const SUBMISSION_LABEL = '群友提交，未经平台核实';
export const AGENT_LABEL = 'AI 采集，未经平台核实';
// 名称里通常已经带「虚构·」，摘要里也说「虚构体验」。标签只补「演示数据」
// 这一个维度，避免同一张卡片上出现三次「虚构」。
export const DEMO_LABEL = '演示数据';
/**
 * 页脚总声明。三种来源必须各自点名：
 * - demo：种子数据，但界面上会和真实内容混在一起；
 * - submission：群友表单提交；
 * - agent：AI Agent 通过公开接口提交。
 * 少写 agent 一类时，页脚只说「演示数据」和「群友提交」，读者会把 AI 采集的内容
 * 当成这两者之一——而它是程序写的，性质既不是演示也不是人工提交。
 */
export const SITE_NOTICE = '标注「演示数据」的站点与内容是虚构样例；标注「群友提交」的内容来自群友表单、标注「AI 采集」的内容来自 AI Agent 提交，两类均为用户或程序提供、未经平台核实。以上均不构成消费建议';

/**
 * 正文按纯文本显示（不走 Markdown）的来源。
 *
 * 判据是「这段正文由外部程序或第三方表单写入，我们不知道里面写了什么」：
 * submission 来自飞书表单、agent 来自公开接口。user 是登录用户在站内写的，
 * demo 是我们自己写的种子内容——这两类照常渲染 Markdown。
 *
 * 以前这里直接用 `sourceLabel(x) !== null` 兼职做判断，demo 一旦有了标签就被
 * 误归到「不可信」里。标签是给读者看的，信任判定是给渲染器用的，两件事。
 */
export function isUntrustedSource(source: ContentSource | 'user' | undefined): boolean {
  return source === 'submission' || source === 'agent';
}

/**
 * 来源标签。**demo 也要给标签**。
 *
 * 原先这里对 demo 返回 null，注释里说「演示数据靠名称里的『虚构』二字区分」。
 * 那个约定只在种子数据里成立：卡片、详情页、对比表、将来的 sitemap 都只管
 * 调 sourceLabel，拿不到标签就等于「和真实内容长得一样」。
 * 一旦这些入口增多，漏标记只是时间问题。
 */
export function sourceLabel(source: ContentSource | 'user' | undefined): string | null {
  if (source === 'demo') return DEMO_LABEL;
  if (source === 'submission') return SUBMISSION_LABEL;
  if (source === 'agent') return AGENT_LABEL;
  return null;
}

/** 回跳地址按浏览器的规则解析（它会吃掉制表符、把反斜杠当斜杠），同源才放行，防止登录页被用来跳转到外站。 */
export function safeNext(next: string | null) {
  if (!next) return '/';
  try {
    const url = new URL(next, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}
export const loginPath = (from: string) => `/login?next=${encodeURIComponent(from)}`;

export const NOT_AVAILABLE = '暂无';
export const formatUptime = (uptime: number | null) => uptime === null ? NOT_AVAILABLE : `${uptime}%`;
export const formatLatency = (ms: number | null) => ms === null ? NOT_AVAILABLE : `${ms} ms`;
export const formatStatus = (status: StationStatus | null) => status === null ? NOT_AVAILABLE : status === 'running' ? '运行中' : '运行波动';

export const formatRate = (rate: number) => `${rate}x`;

/**
 * 计价口径的展示名。
 *
 * `rate` 只说「相对官方价多少」，不说这个数字怎么来的。输入按量、输出按量、
 * 打包价、整站混合四种口径下同一个数字含义完全不同，并排放又不标口径，
 * 会让读者以为是同一件事的四个报价。
 */
const RATE_BASIS_LABEL: Record<RateBasis, string> = {
  blended: '综合',
  input: '按输入',
  output: '按输出',
  package: '打包价',
};
export const formatRateBasis = (basis: RateBasis | undefined) => {
  // 缺字段按综合读（老数据）；但「有值但不是四种之一」只能来自老库的历史脏值
  // （ALTER 补不上 CHECK），显示成未知口径——默默按综合读会替它编一个口径。
  if (basis === undefined) return RATE_BASIS_LABEL.blended;
  return RATE_BASIS_LABEL[basis] ?? '未知口径';
};

/**
 * 报价时间。null 表示来源没说，显示成「时间未知」而不是「刚刚」——
 * 后者是凭空给了一条它没有的信息。
 */
export const formatQuotedAt = (iso: string | null | undefined) => {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return formatDate(iso);
};
export const formatPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;

// 与服务端日期口径一致；en-CA 输出 YYYY-MM-DD。
const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const shanghaiTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, dateStyle: 'short', timeStyle: 'short' });
export const formatDate = (iso: string) => shanghaiDate.format(new Date(iso));

/**
 * 日期 + 时间，固定东八区。
 *
 * 全站时间口径是 Asia/Shanghai；直接用 `toLocaleString('zh-CN')` 会取浏览器时区，
 * 非东八区用户看到的「提交时间/流水时间」会和详情页差好几个小时。
 */
export const displayTime = (iso: string) => shanghaiTime.format(new Date(iso));

/**
 * 展示前清掉会破坏排版的不可见字符。
 *
 * 换行、制表符之外的 C0/C1 控制符，以及 U+2028/2029 这两个「行分隔符」，
 * 在 HTML 里不换行但会进入 attr()、复制粘贴与无障碍播报，制造出看起来
 * 没问题但内容错位的文本。后端已经拦了大部分，这里是渲染层的兜底。
 */
export function normalizeDisplay(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, '');
}

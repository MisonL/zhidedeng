import type { ContentSource, PostKind, StationStatus } from '@zhidedeng/shared';

export const KIND_LABEL: Record<PostKind, string> = {
  deal: '爆料', review: '评测', community: '社区', guide: '指南',
};

export const DISCLAIMER = '当前为演示数据，不构成消费建议';
export const SUBMISSION_LABEL = '群友提交，未经平台核实';
export const AGENT_LABEL = 'AI 采集，未经平台核实';
export const SITE_NOTICE = '带「虚构」字样的站点与内容是演示数据；标注「群友提交」的内容来自群友表单，未经平台核实。两者均不构成消费建议';

export function sourceLabel(source: ContentSource | 'user' | undefined): string | null {
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
export const formatPercent = (ratio: number) => `${Math.round(ratio * 100)}%`;

// 与服务端日期口径一致；en-CA 输出 YYYY-MM-DD。
const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export const formatDate = (iso: string) => shanghaiDate.format(new Date(iso));

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

import { useSearchParams, Link } from 'react-router';
import type { Station } from '@zhidedeng/shared';
import { api } from '../api';
import AsyncView, { Empty } from '../components/AsyncView';
import { formatDate, formatLatency, formatRate, formatStatus, formatUptime, NOT_AVAILABLE } from '../format';
import { LoadMore } from '../components/AsyncView';
import { usePaged } from '../hooks';

/** 最多同时对比几个站。再多就不是「对比」而是一张看不清的表。 */
export const COMPARE_LIMIT = 3;

/**
 * 查询参数里的站点列表。去重、去空、保留顺序。
 *
 * **不在这里截断**：链接里带了 4 个站时，如果解析阶段就默默丢掉第 4 个，
 * 用户看到的是「3 个站在对比」，却不知道少了什么。截断交给页面，页面会
 * 明说「只对比前 3 个」。
 */
export function parseSlugs(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const slug = part.trim();
    // 空串必须跳过：`?s=a,,b` 会切出一个空 slug，拿去查库没有意义。
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

interface Row {
  label: string;
  /** 每站取一个值；null 表示这站没有这项数据。 */
  value: (station: Station) => string;
  /** 这一行是不是「越高/越低更好」会影响有没有高亮，这里只标说明性文字。 */
  hint?: string;
}

const ROWS: Row[] = [
  {
    label: '最低倍率',
    // 只用综合口径：按输入 token 算出来的 0.3x 和整站 0.5x 不是一件事，
    // 混在一行里比大小会得出错误结论（服务端的 lowestRate 已经只取综合口径）。
    value: station => station.lowestRate === null ? NOT_AVAILABLE : formatRate(station.lowestRate),
    hint: '仅综合口径，不含按量/打包价',
  },
  { label: '可用率', value: station => formatUptime(station.uptime) },
  { label: '首 token 延迟', value: station => formatLatency(station.firstTokenLatencyMs) },
  { label: '综合得分', value: station => station.score === null ? NOT_AVAILABLE : String(station.score) },
  { label: '社区最后确认', value: station => station.lastConfirmedAt ? formatDate(station.lastConfirmedAt) : '还没有人聊过' },
  { label: '充值门槛', value: station => station.rechargeThreshold === null ? NOT_AVAILABLE : `${station.rechargeThreshold} 元起` },
  { label: '支付方式', value: station => station.paymentMethods.join('、') || NOT_AVAILABLE },
  { label: '成立时间', value: station => station.foundedAt?.slice(0, 7) ?? NOT_AVAILABLE },
  { label: '运行状态', value: station => formatStatus(station.status) },
];

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const requested = parseSlugs(params.get('s'));
  const chosen = requested.slice(0, COMPARE_LIMIT);
  const overflow = requested.length - chosen.length;
  // 分页拉全站。原先只取第一页 50 条，站点一多，第三页之后的站就永远选不到，
  // 而对比页的「可选项」本该是全部真实站。LoadMore 会接着取下一页。
  const all = usePaged((page, signal) => api.getStations({ page, pageSize: 50, sort: 'score' }, signal), []);

  function toggle(slug: string) {
    const next = chosen.includes(slug)
      ? chosen.filter(item => item !== slug)
      : [...chosen, slug].slice(0, COMPARE_LIMIT);
    setParams(next.length > 0 ? { s: next.join(',') } : {}, { replace: true });
  }

  return (
    <section className="page">
      <title>站点对比 · 什么值得蹬</title>
      <h1 className="page-title">站点对比</h1>
      <p className="page-sub">选 2~{COMPARE_LIMIT} 个站并排看。只比倍率，不比价格；演示数据不参与对比。</p>

      <AsyncView
        state={all}
        isEmpty={items => items.filter(station => station.source !== 'demo').length === 0}
        empty={<Empty title="还没有可对比的站点" action={{ to: '/stations', label: '去看看中转站' }} />}
      >
        {(items) => {
          if (items.length === 0) return null;
          // 演示站不参与对比：它们是虚构样例，和真实站并排会让人以为在比真实选择。
          const candidates = items.filter(station => station.source !== 'demo');
          const picked = chosen
            .map(slug => candidates.find(station => station.slug === slug))
            .filter((station): station is Station => station !== undefined);
          const missing = chosen.filter(slug => !candidates.some(station => station.slug === slug));

          return (
            <>
              <div className="tags compare-picker">
                {candidates.map((station) => {
                  const selected = chosen.includes(station.slug);
                  return (
                    <button
                      key={station.slug} type="button" className={`tag ${selected ? 'tag-good' : ''}`}
                      aria-pressed={selected} onClick={() => toggle(station.slug)}
                      disabled={!selected && chosen.length >= COMPARE_LIMIT}
                    >
                      {station.name}
                    </button>
                  );
                })}
              </div>

              {/* 查询串里带着已被删除/下架的站、或者超过 3 个：都说出来，而不是悄悄忽略。 */}
              {missing.length > 0 && (
                <p className="hint">{missing.length} 个站点已不可对比（可能是演示数据或已下架）</p>
              )}
              {overflow > 0 && (
                <p className="hint">一次最多对比 {COMPARE_LIMIT} 个站，多出的 {overflow} 个没有显示</p>
              )}

              {picked.length === 0 && <p className="hint">上面选两个站开始对比。</p>}
              {picked.length === 1 && <p className="hint">再选一个就能并排比较了。</p>}

              {picked.length > 0 && (
                <div className="table-scroll">
                  <table className="data-table compare-table">
                    <thead>
                      <tr>
                        <th scope="col">对比项</th>
                        {picked.map(station => (
                          <th key={station.slug} scope="col"><Link to={`/stations/${station.slug}`}>{station.name}</Link></th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ROWS.map(row => (
                        <tr key={row.label}>
                          <th scope="row">
                            {row.label}
                            {row.hint && <span className="hint compare-hint">{row.hint}</span>}
                          </th>
                          {picked.map(station => (
                            <td key={station.slug} className="num">{row.value(station)}</td>
                          ))}
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
      {/* 站点很多时，后面的页要能取到，否则「可选项」不全。 */}
      <LoadMore paged={all} />
    </section>
  );
}

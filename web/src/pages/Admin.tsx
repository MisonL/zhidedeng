import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { feishuHostnameKey } from '@zhidedeng/shared';
import type { Station, SubmissionRecord } from '@zhidedeng/shared';
import { admin, adminToken, AdminError } from '../admin';
import type { AdminPostRow, RemovedPost, RemovedStation } from '../admin';
import { Skeleton } from '../components/AsyncView';
import { useCatalog } from '../state';

/** 服务端 ids 模式的单批上限，与 submissions.ts 的 schema 保持一致。 */
const BATCH_REVIEW_LIMIT = 100;

const displayTime = (iso: string) => {
  const date = new Date(iso);
  // removedAt 是库里的原始字段，没有格式校验；非法值不该渲染成 "Invalid Date"。
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
};

const KIND_LABEL: Record<string, string> = { station: '站点', model: '模型', post: '文章' };
const CHANNEL_LABEL: Record<string, string> = { feishu: '飞书', agent: 'Agent', web: '站内' };
/** 常见驳回原因。Agent 通道必须给理由，点一下就填上，省得每次手打。 */
const REJECT_PRESETS = ['报价与页面不一致', '站点无法访问', '与已有投稿重复', '内容含广告或推荐语', '字段填写有误'];

/** 投稿内容摘要：待审列表要能一眼看出这条改的是什么。 */
function summarize(submission: SubmissionRecord): string {
  const payload = submission.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return '';
  if (submission.action === 'remove') return `下架 ${String(payload.slug ?? '')}`;
  const name = payload.name ?? payload.title;
  const url = payload.url;
  if (typeof name === 'string' && typeof url === 'string') return `${name} · ${url}`;
  if (typeof name === 'string') return name;
  return typeof payload.slug === 'string' ? payload.slug : '';
}

/**
 * 这条投稿对上线的实际影响。
 *
 * 审核一个站点投稿时，物化是**整包替换**：报价先全删再按投稿重插，
 * 描述、支付方式也是覆盖写。原来这里只显示「名称 · URL」，审核员看不到
 * 「这一通过会删掉多少条报价、把描述换成另一段」，只能靠域名眼熟做判断。
 *
 * 列表接口不返回 offers（只有 lowestRate 汇总），所以这里按条数 + 最低倍率
 * 的变化给出提示，不做逐条 diff——那需要新接口，等真有审核量再说。
 */
function impact(submission: SubmissionRecord, current: Station | undefined): string[] {
  const payload = submission.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return [];
  const offers = Array.isArray(payload.offers) ? payload.offers as Array<{ modelSlug?: unknown; rate?: unknown }> : null;
  if (!offers) return [];
  const rates = offers.map(offer => Number(offer.rate)).filter(rate => Number.isFinite(rate));
  const lowest = rates.length ? Math.min(...rates) : null;
  if (!current) return [`新建站点，提交 ${offers.length} 条报价`];
  const lines = [`更新已有站点：报价将被整包替换为 ${offers.length} 条`];
  if (lowest !== null && current.lowestRate !== null && lowest !== current.lowestRate) {
    lines.push(`最低倍率 ${current.lowestRate}x → ${lowest}x`);
  }
  if (typeof payload.description === 'string' && payload.description !== current.description) {
    lines.push(`描述将被覆盖：${payload.description.slice(0, 60)}${payload.description.length > 60 ? '…' : ''}`);
  }
  return lines;
}

type Tab = 'submissions' | 'posts' | 'published' | 'removed' | 'removedPosts';

export default function Admin() {
  const [token, setToken] = useState(adminToken.get());
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<Tab>('submissions');
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>();
  const [posts, setPosts] = useState<AdminPostRow[]>();
  const [removed, setRemoved] = useState<RemovedStation[]>();
  const [removedPosts, setRemovedPosts] = useState<RemovedPost[]>();
  const [published, setPublished] = useState<AdminPostRow[]>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 驳回理由会写进 submissions.reason，作者在 /me 能看到；不填就只显示「已驳回」。
  const [rejecting, setRejecting] = useState<string>();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // 文章页签单独一套。文章 id 与投稿 id 在「站内投稿物化」时是同一个值，
  // 共用一张 map 会让两个页签互相 prefetch 对方的输入。
  const [rejectingPost, setRejectingPost] = useState<string>();
  const [postReasons, setPostReasons] = useState<Record<string, string>>({});
  // reload 用来在恢复/下架/审核通过后失效目录缓存：否则公开页要手动刷新浏览器
  // 才看得到刚恢复的站点，用户会以为操作没生效。
  const { stationBySlug, reload: reloadCatalog } = useCatalog();

  async function load(active: string, signal?: AbortSignal) {
    // 不在这里清错误：调用方可能刚设好一条操作结果，清掉就等于把它吞了。
    try {
      // 快速切页签时旧请求可能后到，覆盖当前页签的数据。
      // 每个分支各自写状态，中止后就不再落盘。
      if (active === 'submissions') {
        const data = await admin.listAllSubmissions('pending', signal);
        if (!signal?.aborted) setSubmissions(data);
      }
      if (active === 'posts') {
        const data = (await admin.listPosts('pending', signal)).items;
        if (!signal?.aborted) setPosts(data);
      }
      if (active === 'removed') {
        const data = (await admin.listRemovedStations(signal)).items;
        if (!signal?.aborted) setRemoved(data);
      }
      if (active === 'published') {
        const data = (await admin.listPosts('approved', signal)).items;
        if (!signal?.aborted) setPublished(data);
      }
      if (active === 'removedPosts') {
        const data = (await admin.listRemovedPosts(signal)).items;
        if (!signal?.aborted) setRemovedPosts(data);
      }
    } catch (caught) {
      if (signal?.aborted) return;
      // 密钥缺失或被服务端拒绝：退回输入态。留在审核台上只会让用户
      // 对着一个空列表和一条「密钥无效」发呆。
      if (caught instanceof AdminError && (caught.code === 'NO_TOKEN' || caught.unauthorized)) {
        reset();
        // 退回输入态之后必须说明原因。只清空、不提示的话，用户看到的是
        // 「点了进入、输入框自己空了、什么都没发生」，会以为按钮坏了。
        setError(caught.code === 'NO_TOKEN' ? '请填写管理密钥' : '管理密钥无效，请重新输入');
        return;
      }
      setError((caught as Error).message);
    }
  }

  // 换密钥或切页时重新取数；密钥为空就停在输入态。
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setSubmissions(undefined);
    setPosts(undefined);
    setRemoved(undefined);
 setRemovedPosts(undefined);
 setPublished(undefined);
    void load(tab, controller.signal);
    return () => controller.abort();
    // 只在密钥或页签变化时重取；load 每次渲染都是新函数，不参与依赖。
  }, [token, tab]);

  /** 退出或密钥失效时把内存里的列表也清掉，不留残留数据。 */
  function reset() {
    setToken('');
    setSubmissions(undefined);
    setPosts(undefined);
    setRemoved(undefined);
 setRemovedPosts(undefined);
 setPublished(undefined);
    setError(undefined);
    setMessage(undefined);
  }

  function unlock(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return setError('请填写管理密钥');
    adminToken.set(value);
    setDraft('');
    setError(undefined);
    setToken(value);
  }

  /**
   * 批量审核。服务端逐条独立事务，单条失败不改 HTTP 状态码，
   * 只把错误放进 results[].error——不看它就会把部分失败报成全部成功。
   */
  async function approveAll() {
    // 站点/模型必须排在文章前面：文章物化时要靠 hostname 反查站点 slug，
    // 站点还没通过的话 stationSlug 会落成 null。服务端只在单次请求内排序，
    // 超过 BATCH_REVIEW_LIMIT 时分块会把这个保证切断——所以在这里先排好，
    // 再按顺序切块，块间也保持依赖顺序（与服务端 orderByMaterializeDependency 同规则）。
    const ordered = [...(submissions ?? [])].sort(
      (a, b) => Number(a.kind === 'post') - Number(b.kind === 'post'),
    );
    const ids = ordered.map(item => item.id);
    if (ids.length === 0) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      // 服务端 ids 模式一次最多 100 条，超过是整个请求 400（不是逐条失败）。
      // 飞书全量导入一次就可能推入几百条，所以这里必须分批。
      const results: Awaited<ReturnType<typeof admin.batchReview>>['results'] = [];
      for (let start = 0; start < ids.length; start += BATCH_REVIEW_LIMIT) {
        const chunk = await admin.batchReview(ids.slice(start, start + BATCH_REVIEW_LIMIT), 'approved');
        results.push(...chunk.results);
      }
      const failed = results.filter(result => result.error);
      const ok = results.length - failed.length;
      // superseded 不是失败——它表示这条已被同站的新版本替代，线上是另一版。
      // 但也不能笼统算进「已通过」：审核员会以为这批内容都按自己看到的版本
      // 上线了。单独报出来，两者的差别对被替代的那几条是实质性的。
      const superseded = results.filter(result => result.status === 'superseded').length;
      const through = ok - superseded;
      const parts: string[] = [];
      if (through > 0) parts.push(`已通过 ${through} 条`);
      if (superseded > 0) parts.push(`另有 ${superseded} 条已被同站新版本替代`);
      if (failed.length === 0) setMessage(parts.join('，'));
      else {
        setMessage(parts.length > 0 ? parts.join('，') : undefined);
        // 逐条原因要露出来：后端会把 MODEL_EXISTS 这类不可自愈的失败
        // 直接写成 rejected，不说清楚审核员根本不知道发生了什么。
        setError(`${failed.length} 条未通过：${failed.map(result => result.error!.message).join('；')}`);
      }
      await load(tab);
      // 审核通过会让新站/新文章上线，目录缓存必须失效。
      reloadCatalog();
    } catch (caught) {
      // 分块中途炸了，前面几块其实已经审过：不刷新的话列表还显示全部待审，
      // 审核员重试一次就会把「早已通过」的行报成「已审核或被新版本替代」，
      // 越重试越乱。刷新拿真实状态，失败信息另说。
      await load(tab).catch(() => undefined);
      if (caught instanceof AdminError && caught.unauthorized) {
        setToken('');
        setError('管理密钥无效，请重新输入');
        return;
      }
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await run();
      setMessage(done);
      await load(tab);
      // 单条通过/拒绝、下架、恢复都会改变「哪些站和文章在线」，目录缓存跟着失效。
      reloadCatalog();
      return true;
    } catch (caught) {
      if (caught instanceof AdminError && caught.unauthorized) {
        reset();
        // reset() 会连着把 error 清掉，这里补回来：否则密钥失效后输入框
        // 重现却没有任何说明，看着像操作没生效。
        setError('管理密钥无效，请重新输入');
        return false;
      }
      setError((caught as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <section className="page">
        <title>审核台 · 什么值得蹬</title>
        <h1 className="page-title">审核台</h1>
        <p className="hint">
          管理接口用密钥鉴权，不是登录会话。密钥只存在本标签页，关掉就没了。
        </p>
        <form onSubmit={unlock}>
          <div className="field">
            <label className="field-label" htmlFor="admin-token">管理密钥</label>
            <input
              id="admin-token" type="password" value={draft} autoComplete="off"
              onChange={event => setDraft(event.target.value)}
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-red" type="submit">进入</button>
        </form>
      </section>
    );
  }

  const pendingSubmissions = submissions ?? [];
  // 站点类投稿要拿线上当前状态做对比；已下架的站点不在 catalog 里，按「新建」提示。
  /**
   * 站点投稿 payload 里**没有 slug**（只有 name/description/url/报价等），
   * 所以不能按 slug 找当前站点——那样永远找不到，所有卡片都会显示「新建站点」，
   * 而审核员最需要被告警的恰恰是「这条在覆盖已有站点」。按 URL 的 hostname 反查。
   */
  /**
   * 两张索引：**精确 hostname** 与**飞书分组键**。
   *
   * 必须区分开。服务端认领是「精确优先、分组兜底」，而且只有 `channel === 'feishu'`
   * 才分组（agent/web 可以各自持有 www 与裸域两条实体）。审核台只压成一张分组表时：
   *  - www 与裸域各有一条站时，后写覆盖先写，impact 提示指向错的那条；
   *  - web/agent 投稿明明会**新建**一条站，却提示「更新已有站点」。
   */
  type StationEntry = typeof stationBySlug extends Map<string, infer V> ? V : never;
  const stationIndex = (() => {
    const exact = new Map<string, StationEntry>();
    const grouped = new Map<string, StationEntry>();
    for (const station of stationBySlug.values()) {
      if (station.url === null) continue;
      let host: string;
      try { host = new URL(station.url).hostname.toLowerCase().replace(/\.+$/, ''); } catch { continue; }
      if (!exact.has(host)) exact.set(host, station);
      const key = feishuHostnameKey(host);
      if (!grouped.has(key)) grouped.set(key, station);
    }
    return { exact, grouped };
  })();
  /**
   * 投稿正文摘要。审核台原来只显示「名称 · URL」，管理员看不到描述、支付方式、
   * 报价明细——而站点审核是整包替换，看不到明细就没法判断这次通过会丢掉什么。
   */
  const payloadDetail = (item: SubmissionRecord) => {
    const payload = item.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') return null;
    const lines: string[] = [];
    const description = payload.description;
    if (typeof description === 'string' && description.trim() !== '') {
      lines.push(`描述：${description}`);
    }
    const threshold = payload.rechargeThreshold;
    if (threshold === null) lines.push('充值门槛：无');
    else if (typeof threshold === 'number') lines.push(`充值门槛：¥${threshold}`);
    const methods = Array.isArray(payload.paymentMethods) ? payload.paymentMethods.filter((m): m is string => typeof m === 'string') : null;
    if (methods) lines.push(`支付方式：${methods.length ? methods.join('、') : '未填'}`);
    const offers = Array.isArray(payload.offers)
      ? payload.offers as Array<{ modelSlug?: unknown; rate?: unknown }>
      : null;
    if (offers && offers.length) {
      const rated = offers
        .filter(offer => typeof offer.modelSlug === 'string' && Number.isFinite(Number(offer.rate)))
        .map(offer => `${String(offer.modelSlug)} ${Number(offer.rate)}x`);
      lines.push(`报价（${offers.length} 条）：${rated.join('、')}`);
    }
    const body = payload.body;
    if (typeof body === 'string') lines.push(`正文：${body}`);
    const summary = payload.summary;
    if (typeof summary === 'string') lines.push(`摘要：${summary}`);
    return lines.length ? lines : null;
  };

  const impactLines = (item: SubmissionRecord): string[] => {
    if (item.kind !== 'station' || item.action === 'remove') return [];
    const payload = item.payload as Record<string, unknown> | null;
    const url = payload && typeof payload.url === 'string' ? payload.url : null;
    if (url === null) return impact(item, undefined);
    let host: string;
    try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/, ''); } catch { return impact(item, undefined); }
    // 精确命中优先；分组只在飞书渠道兜底——与服务端认领口径一致。
    const target = stationIndex.exact.get(host)
      ?? (item.channel === 'feishu' ? stationIndex.grouped.get(feishuHostnameKey(host)) : undefined);
    return impact(item, target);
  };
  const pendingPosts = posts ?? [];
  const removedStations = removed ?? [];
  const withdrawnPosts = removedPosts ?? [];
  const publishedPosts = published ?? [];

  return (
    <section className="page">
      <h1 className="page-title">审核台</h1>
<div className="tags" role="tablist" aria-label="审核台">
        <button type="button" role="tab" aria-selected={tab === 'submissions'} className={`btn btn-small ${tab === 'submissions' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('submissions')}>
          待审投稿 {submissions ? `(${pendingSubmissions.length})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'posts'} className={`btn btn-small ${tab === 'posts' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('posts')}>
          待审文章 {posts ? `(${pendingPosts.length})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'published'} className={`btn btn-small ${tab === 'published' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('published')}>
          已上线文章 {published ? `(${publishedPosts.length})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'removed'} className={`btn btn-small ${tab === 'removed' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('removed')}>
          已下架站点 {removed ? `(${removedStations.length})` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'removedPosts'} className={`btn btn-small ${tab === 'removedPosts' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('removedPosts')}>
          已下架文章 {removedPosts ? `(${withdrawnPosts.length})` : ''}
        </button>
      </div>
      {/* 退出不是页签：它不切换内容区，放在 tablist 外面，否则读屏会把它
          念成一个「当前未选中」的页签。 */}
      <div className="tags">
        <button type="button" className="btn btn-small btn-ghost" onClick={() => { adminToken.clear(); reset(); }}>
          退出
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {message && <p className="form-success">{message}</p>}

      {tab === 'submissions' && (
        submissions === undefined ? <Skeleton /> : pendingSubmissions.length === 0
          ? <p className="state">没有待审投稿</p>
          : (
            <>
              <div className="tags">
                <button
                  className="btn btn-small btn-red" disabled={busy}
                  onClick={() => {
                    // 通过不可撤销：服务端对非 pending 一律 409 ALREADY_REVIEWED。
                    // 站点以自动运行为主，但一次误点把几百条全放出去没有回退手段。
                    if (!window.confirm(`确认通过全部 ${pendingSubmissions.length} 条待审投稿？此操作不可撤销。`)) return;
                    void approveAll();
                  }}
                >
                  全部通过
                </button>
              </div>
              <ul className="card-list">
                {pendingSubmissions.map(item => (
                  <li key={item.id}>
                    <div className="tags">
                      <span className="tag">{KIND_LABEL[item.kind] ?? item.kind}</span>
                      <span className="tag">{CHANNEL_LABEL[item.channel] ?? item.channel}</span>
                      {item.action === 'remove' && <span className="tag tag-warn">下架</span>}
                      {item.actorHandle && <span className="tag">{item.actorHandle}</span>}
                      <span className="hint">{displayTime(item.createdAt)}</span>
                    </div>
                    <p>{summarize(item)}</p>
                    <p className="hint">{item.originKey}</p>
                    {(() => {
                      const detail = payloadDetail(item);
                      if (!detail) return null;
                      return (
                        <details className="payload-detail">
                          <summary>展开投稿内容</summary>
                          {detail.map(line => <p className="hint" key={line}>{line}</p>)}
                        </details>
                      );
                    })()}
                    {impactLines(item).map(line => (
                      <p className="hint" key={line}>{line}</p>
                    ))}
                    {rejecting === item.id && (
                      <div className="field">
                        <label className="field-label" htmlFor={`reason-${item.id}`}>
                          {(item.channel === 'agent' || item.kind === 'post') ? '驳回理由（必填，作者可见）' : '驳回理由（可选）'}
                        </label>
                        <input
                          id={`reason-${item.id}`} value={reasons[item.id] ?? ''} maxLength={200}
                          onChange={event => setReasons({ ...reasons, [item.id]: event.target.value })}
                        />
                        {item.channel === 'agent' && (
                          <div className="tags">
                            {REJECT_PRESETS.map(preset => (
                              <button
                                key={preset} type="button" className="tag"
                                onClick={() => setReasons({ ...reasons, [item.id]: preset })}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        )}
                        <button
                          className="btn btn-small btn-ghost" disabled={busy}
                          onClick={() => {
                            const reason = reasons[item.id]?.trim();
                            // 服务端对 Agent 通道与所有文章强制要求理由；这里先拦一下，省一次往返。
                            if ((item.channel === 'agent' || item.kind === 'post') && !reason) {
                              setError(item.kind === 'post' ? '驳回文章时必须填写理由，作者要靠它修改后重投' : 'Agent 投稿驳回时必须填理由，点上面的常用原因即可');
                              return;
                            }
                            void act(
                              () => admin.reviewSubmission(item.id, 'rejected', reason || undefined),
                              '已拒绝',
                            ).then(() => setRejecting(undefined));
                          }}
                        >
                          确认拒绝
                        </button>
                      </div>
                    )}
                    <div className="tags">
                      <button
                        className="btn btn-small btn-red" disabled={busy}
                        onClick={() => act(() => admin.reviewSubmission(item.id, 'approved'), '已通过')}
                      >
                        通过
                      </button>
                      <button
                        className="btn btn-small btn-ghost" disabled={busy}
                        onClick={() => setRejecting(rejecting === item.id ? undefined : item.id)}
                      >
                        拒绝
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )
      )}

      {tab === 'posts' && (
        posts === undefined ? <Skeleton /> : pendingPosts.length === 0
          ? <p className="state">没有待审文章</p>
          : (
            <ul className="card-list">
              {pendingPosts.map(post => (
                <li key={post.id}>
                  <div className="tags">
                    <span className="tag">{KIND_LABEL[post.kind] ?? post.kind}</span>
                    <span className="tag">{post.authorHandle ?? '匿名'}</span>
                    <span className="hint">{displayTime(post.publishedAt)}</span>
                  </div>
                  <p>{post.title}</p>
                  <p className="hint">{post.summary}</p>
                  {rejectingPost === post.id && (
                    <div className="field">
                      <label className="field-label" htmlFor={`post-reason-${post.id}`}>驳回理由（必填，作者可见）</label>
                      <input
                        id={`post-reason-${post.id}`} value={postReasons[post.id] ?? ''} maxLength={200}
                        placeholder="说明哪里不合格，作者据此修改后重投"
                        onChange={event => setPostReasons({ ...postReasons, [post.id]: event.target.value })}
                      />
                      <div className="tags">
                        {REJECT_PRESETS.map(preset => (
                          <button key={preset} type="button" className="tag"
                            onClick={() => setPostReasons({ ...postReasons, [post.id]: preset })}>
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="tags">
                    <button
                      className="btn btn-small btn-red" disabled={busy}
                      onClick={() => act(() => admin.reviewPost(post.id, 'approved'), '已通过')}
                    >
                      通过
                    </button>
                    {rejectingPost === post.id ? (
                      <>
                        <button
                          className="btn btn-small btn-ghost" disabled={busy}
                          onClick={() => {
                            const reason = postReasons[post.id]?.trim();
                            if (!reason) { setError('拒绝文章时必须填写理由，作者要靠它修改重投'); return; }
                            void act(() => admin.reviewPost(post.id, 'rejected', reason), '已拒绝')
                              .then((ok) => { if (ok) setRejectingPost(undefined); });
                          }}
                        >
                          确认拒绝
                        </button>
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => {
                          setRejectingPost(undefined);
                          setPostReasons((current) => { const { [post.id]: _removed, ...rest } = current; return rest; });
                        }}>取消</button>
                      </>
                    ) : (
                      <button
                        className="btn btn-small btn-ghost" disabled={busy}
                        onClick={() => setRejectingPost(post.id)}
                      >
                        拒绝
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
      )}

      {tab === 'published' && (
        // 已上线内容的撤回入口。待审列表里放「下架」是错位的——那些还没上线，
        // 实体根本不存在，点下去只会 404，而作者那边会以为稿子没了。
        published === undefined ? <Skeleton /> : publishedPosts.length === 0
          ? <p className="state">没有已上线的文章</p>
          : (
            <ul className="card-list">
              {publishedPosts.map(post => (
                <li key={post.id}>
                  <div className="tags">
                    <span className="tag">{KIND_LABEL[post.kind] ?? post.kind}</span>
                    <span className="tag">{post.authorHandle ?? '匿名'}</span>
                    <span className="hint">{displayTime(post.publishedAt)}</span>
                  </div>
                  <p>{post.title}</p>
                  <p className="hint">{post.summary}</p>
                  <div className="tags">
                    <button
                      className="btn btn-small btn-red" disabled={busy}
                      onClick={() => act(async () => { await admin.withdrawPost(post.id); setTab('removedPosts'); }, '已下架，可在「已下架文章」里恢复')}
                    >
                      下架
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
      )}

      {tab === 'removedPosts' && (
        // 已发布内容也要能撤回。群友来源的文章原先只有「去飞书撤销通过」
        // 一条路，而那条路走不通（撤销后记录就不在批次里了，生成不了下架请求）。
        removedPosts === undefined ? <Skeleton /> : withdrawnPosts.length === 0
          ? <p className="state">没有已下架的文章</p>
          : (
            <ul className="card-list">
              {withdrawnPosts.map(post => (
                <li key={post.id}>
                  <p>{post.id}</p>
                  <p className="hint">下架于 {displayTime(post.removedAt)}</p>
                  <div className="tags">
                    <button
                      className="btn btn-small btn-red" disabled={busy}
                      onClick={() => act(() => admin.restorePost(post.id), '已恢复')}
                    >
                      恢复
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
      )}

      {tab === 'removed' && (
        removed === undefined ? <Skeleton /> : removedStations.length === 0
          ? <p className="state">没有已下架的站点</p>
          : (
            <ul className="card-list">
              {removedStations.map(station => (
                <li key={station.slug}>
                  <p>{station.slug}</p>
                  <p className="hint">下架于 {displayTime(station.removedAt)}</p>
                  <div className="tags">
                    <button
                      className="btn btn-small btn-red" disabled={busy}
                      onClick={() => act(() => admin.restoreStation(station.slug), '已恢复')}
                    >
                      恢复
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
      )}
    </section>
  );
}

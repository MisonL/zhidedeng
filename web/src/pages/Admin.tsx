import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SubmissionRecord } from '@zhidedeng/shared';
import { admin, adminToken, AdminError } from '../admin';
import type { AdminPostRow, RemovedStation } from '../admin';
import { Skeleton } from '../components/AsyncView';

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

type Tab = 'submissions' | 'posts' | 'removed';

export default function Admin() {
  const [token, setToken] = useState(adminToken.get());
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<Tab>('submissions');
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>();
  const [posts, setPosts] = useState<AdminPostRow[]>();
  const [removed, setRemoved] = useState<RemovedStation[]>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 驳回理由会写进 submissions.reason，作者在 /me 能看到；不填就只显示「已驳回」。
  const [rejecting, setRejecting] = useState<string>();
  const [reasons, setReasons] = useState<Record<string, string>>({});

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
    const ids = (submissions ?? []).map(item => item.id);
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
      if (failed.length === 0) setMessage(`已通过 ${ok} 条`);
      else {
        setMessage(ok > 0 ? `已通过 ${ok} 条` : undefined);
        // 逐条原因要露出来：后端会把 MODEL_EXISTS 这类不可自愈的失败
        // 直接写成 rejected，不说清楚审核员根本不知道发生了什么。
        setError(`${failed.length} 条未通过：${failed.map(result => result.error!.message).join('；')}`);
      }
      await load(tab);
    } catch (caught) {
      if (caught instanceof AdminError && caught.unauthorized) {
        setToken('');
        return;
      }
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await run();
      setMessage(done);
      await load(tab);
    } catch (caught) {
      if (caught instanceof AdminError && caught.unauthorized) {
        reset();
        return;
      }
      setError((caught as Error).message);
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
  const pendingPosts = posts ?? [];
  const removedStations = removed ?? [];

  return (
    <section className="page">
      <h1 className="page-title">审核台</h1>
      <div className="tags">
        <button className={`btn btn-small ${tab === 'submissions' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('submissions')}>
          待审投稿 {submissions ? `(${pendingSubmissions.length})` : ''}
        </button>
        <button className={`btn btn-small ${tab === 'posts' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('posts')}>
          待审文章 {posts ? `(${pendingPosts.length})` : ''}
        </button>
        <button className={`btn btn-small ${tab === 'removed' ? 'btn-red' : 'btn-ghost'}`} onClick={() => setTab('removed')}>
          已下架站点 {removed ? `(${removedStations.length})` : ''}
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => { adminToken.clear(); reset(); }}>
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
                    {rejecting === item.id && (
                      <div className="field">
                        <label className="field-label" htmlFor={`reason-${item.id}`}>驳回理由（可选）</label>
                        <input
                          id={`reason-${item.id}`} value={reasons[item.id] ?? ''} maxLength={200}
                          onChange={event => setReasons({ ...reasons, [item.id]: event.target.value })}
                        />
                        <button
                          className="btn btn-small btn-ghost" disabled={busy}
                          onClick={() => void act(
                            () => admin.reviewSubmission(item.id, 'rejected', reasons[item.id]?.trim() || undefined),
                            '已拒绝',
                          ).then(() => setRejecting(undefined))}
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
                    <span className="tag">{KIND_LABEL[post.kind] ? post.kind : post.kind}</span>
                    <span className="tag">{post.authorHandle ?? '匿名'}</span>
                    <span className="hint">{displayTime(post.publishedAt)}</span>
                  </div>
                  <p>{post.title}</p>
                  <p className="hint">{post.summary}</p>
                  <div className="tags">
                    <button
                      className="btn btn-small btn-red" disabled={busy}
                      onClick={() => act(() => admin.reviewPost(post.id, 'approved'), '已通过')}
                    >
                      通过
                    </button>
                    <button
                      className="btn btn-small btn-ghost" disabled={busy}
                      onClick={() => act(() => admin.reviewPost(post.id, 'rejected'), '已拒绝')}
                    >
                      拒绝
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

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SubmissionRecord } from '@zhidedeng/shared';
import { admin, adminToken, AdminError } from '../admin';
import type { AdminPostRow, RemovedStation } from '../admin';
import { Skeleton } from '../components/AsyncView';

const displayTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

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

  async function load(active: string) {
    setError(undefined);
    try {
      if (active === 'submissions') setSubmissions((await admin.listSubmissions('pending')).items);
      if (active === 'posts') setPosts((await admin.listPosts('pending')).items);
      if (active === 'removed') setRemoved((await admin.listRemovedStations()).items);
    } catch (caught) {
      // 密钥缺失或被服务端拒绝：退回输入态。留在审核台上只会让用户
      // 对着一个空列表和一条「密钥无效」发呆。
      if (caught instanceof AdminError && (caught.code === 'NO_TOKEN' || caught.unauthorized)) {
        setToken('');
        return;
      }
      setError((caught as Error).message);
    }
  }

  // 换密钥或切页时重新取数；密钥为空就停在输入态。
  useEffect(() => {
    if (!token) return;
    setSubmissions(undefined);
    setPosts(undefined);
    setRemoved(undefined);
    void load(tab);
    // 只在密钥或页签变化时重取。
  }, [token, tab]);

  function unlock(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return setError('请填写管理密钥');
    adminToken.set(value);
    setDraft('');
    setError(undefined);
    setToken(value);
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
        setToken('');
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
        <button className="btn btn-small btn-ghost" onClick={() => { adminToken.clear(); setToken(''); }}>
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
                  onClick={() => act(
                    () => admin.batchReview(pendingSubmissions.map(item => item.id), 'approved'),
                    `已通过 ${pendingSubmissions.length} 条`,
                  )}
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
                    <div className="tags">
                      <button
                        className="btn btn-small btn-red" disabled={busy}
                        onClick={() => act(() => admin.reviewSubmission(item.id, 'approved'), '已通过')}
                      >
                        通过
                      </button>
                      <button
                        className="btn btn-small btn-ghost" disabled={busy}
                        onClick={() => act(() => admin.reviewSubmission(item.id, 'rejected'), '已拒绝')}
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

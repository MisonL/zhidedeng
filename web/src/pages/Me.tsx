import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CurrentUser } from '@zhidedeng/shared';
import { PROFILE_LIMITS } from '@zhidedeng/shared';
import { api } from '../api';
import AsyncView, { Empty, LoadMore, Skeleton } from '../components/AsyncView';
import ConfirmButton from '../components/ConfirmButton';
import PostCard from '../components/PostCard';
import StationCard from '../components/StationCard';
import { Avatar, AvatarPresetGlyph } from '../components/visuals';
import { AVATAR_PRESET_NAMES, AVATAR_PRESETS } from '@zhidedeng/shared';
import { formatDate, loginPath } from '../format';
import { usePaged } from '../hooks';
import { useHere, useMe } from '../state';
import AgentTokens from './AgentTokens';

const TABS = [
  { value: 'favorites', label: '我的收藏' },
  { value: 'posts', label: '我的分享' },
  // 文章之外还有模型补录和站点推荐，那两条也有审核和驳回理由。
  // 只在「我的分享」里看，作者补了模型/站点就查不到任何结果。
  { value: 'submissions', label: '我的投稿' },
  { value: 'notifications', label: '通知' },
  { value: 'settings', label: '账户设置' },
] as const;

type SubmissionItem = Awaited<ReturnType<typeof api.getMySubmissions>>['items'][number];
const KIND_LABEL: Record<'station' | 'model' | 'post', string> = { station: '中转站', model: '模型', post: '文章' };
const STATUS_LABEL: Record<string, string> = { pending: '审核中', approved: '已通过', rejected: '未通过', superseded: '已被新提交替代' };

/** 三种投稿的落地链接不同：站点/模型/文章各有自己的详情页。 */
function submissionPath(item: Pick<SubmissionItem, 'kind' | 'targetSlug'>) {
  if (!item.targetSlug) return null;
  if (item.kind === 'station') return `/stations/${item.targetSlug}`;
  if (item.kind === 'model') return `/models/${item.targetSlug}`;
  return `/posts/${item.targetSlug}`;
}

/**
 * 「我的通知」：只显示本人相关的事件，拉模型。
 *
 * 不显示未读数：没有推送通道，红点要么永远不消失、要么永远滞后，
 * 比没有更让人困惑。用户想看的时候点进这个页签即可。
 */
function MyNotifications() {
  const paged = usePaged((page, signal) => api.getMyNotifications({ page, pageSize: 20 }, signal), []);
  return (
    <>
      <AsyncView
        state={paged}
        isEmpty={(items) => items.length === 0}
        empty={<Empty title="还没有通知" action={{ to: '/submit', label: '去投稿' }} />}
      >
        {(items) => (
          <div className="card-list">
            {items.map((item) => {
              const body = (
                <>
                  <div className="tags">
                    <span className="tag">
                      {item.kind === 'submission' ? '投稿' : item.kind === 'report' ? '举报' : '文章'}
                    </span>
                    <time className="hint num" dateTime={item.at}>{formatDate(item.at)}</time>
                  </div>
                  <h3 className="card-title">{item.title}</h3>
                  {item.detail && <p className="hint">{item.detail}</p>}
                </>
              );
              // 没链接的用 div：给一个点不动的 article 包着 Link 会多出空点击区。
              return item.href
                ? <Link key={item.id} className="card" to={item.href}>{body}</Link>
                : <article key={item.id} className="card">{body}</article>;
            })}
          </div>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </>
  );
}

function MySubmissions() {
  const paged = usePaged((page, signal) => api.getMySubmissions({ page, pageSize: 10 }, signal), []);
  return (
    <>
      <AsyncView
        state={paged}
        isEmpty={(items) => items.length === 0}
        empty={<Empty title="还没有投稿" action={{ to: '/submit', label: '去投稿' }} />}
      >
        {(items) => (
          <div className="card-list">
            {items.map((item) => {
              const to = submissionPath(item);
              const reason = item.status === 'rejected' ? item.reason : null;
              return (
                <article key={item.id} className="card">
                  <div className="tags">
                    <span className="tag">{KIND_LABEL[item.kind]}</span>
                    <span className={`tag ${item.status === 'rejected' || item.withdrawn ? 'tag-warn' : ''}`}>
                      {item.withdrawn ? '已撤下' : STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </div>
                  <h3 className="post-title">{to ? <Link to={to}>{item.title}</Link> : item.title}</h3>
                  {/* 驳回理由必须能看见：否则作者只知道没通过，不知道改什么。 */}
                  {reason && <p className="post-review-reason">未通过原因：{reason}</p>}
                  <p className="hint">
                    {item.status === 'approved' && to ? '已上线，点标题查看'
                      // 已通过但没有落地链接：作者自己撤下了，或管理员下架了。
                      // 这时说「已通过」会让人以为撤下没生效。
                      : item.withdrawn ? '已撤下，需要恢复请站内联系管理员'
                      : item.status === 'approved' ? '已通过'
                      // superseded 说明线上已经是同站的新版本，这条不必再等也不必改。
                      // 原先一律落到「审核后才会公开」，和上面的「已被新提交替代」互相矛盾。
                      : item.status === 'superseded' ? '已被同站新版本替代，无需处理'
                      : '审核后才会公开'}
                  </p>
                </article>
              );
            })}
          </div>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </>
  );
}

function Favorites() {
  const paged = usePaged((page, signal) => api.getMyFavorites({ page, pageSize: 10 }, signal), []);
  return (
    <>
      <AsyncView state={paged} isEmpty={(items) => items.length === 0} empty={<Empty title="还没有收藏" action={{ to: '/', label: '去逛逛' }} />}>
        {(items) => (
          <div className="card-list">
            {items.map((item) => (item.targetType === 'post'
              ? <PostCard key={`post-${item.targetId}`} post={item.post} />
              : <StationCard key={`station-${item.targetId}`} station={item.station} />))}
          </div>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </>
  );
}

function MyPosts() {
  const paged = usePaged((page, signal) => api.getMyPosts({ page, pageSize: 10 }, signal), []);
  // 页头的「分享 N」读的是 /api/me。撤下后不刷新它，页头还显示撤之前的数字，
  // 而下面的列表已经少了一篇——同一屏里两个互相矛盾的数字（实测见过 1 vs 0）。
  const { refreshMe, setMe, data: me } = useMe();
  // 本地已撤下的 id。撤下后不整页重取：重取会让列表跳回第一页，
  // 而作者往往是从第 2 页翻到某篇才决定撤的。
  const [withdrawn, setWithdrawn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function withdraw(id: string) {
    setBusy(id);
    setError(undefined);
    try {
      await api.deletePost(id);
      setWithdrawn((set) => new Set(set).add(id));
      // 先在本地把页头的「分享」减一，再去取真实值：refreshMe 失败时只会 toast，
      // 不会抛错，但如果只依赖它，网络抖动就会让页头停在撤之前的数字。
      if (me) setMe({ ...me, shareCount: Math.max(0, me.shareCount - 1) });
      // 刷新失败不该把「已撤下」这条成功信息吞掉：refreshMe 自己会 toast。
      await refreshMe();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      <AsyncView state={paged} isEmpty={(items) => items.length === 0} empty={<Empty title="还没有分享" action={{ to: '/submit', label: '去投稿' }} />}>
        {(items) => (
          <div className="card-list">
            {items.map((post) => (
              <div key={post.id}>
                <PostCard post={post} />
                {post.status === 'approved' && (withdrawn.has(post.id)
                  ? <p className="hint">已撤下。需要恢复请站内联系管理员。</p>
                  : (
                    <p className="hint">
                      <ConfirmButton
                        label="撤下这篇文章" tone="red" busy={busy === post.id}
                        description="撤下后其他人立刻看不到，正文仍保留，可请管理员恢复。确定撤下？"
                        confirmLabel="撤下"
                        onConfirm={() => withdraw(post.id)}
                      />
                    </p>
                  ))}
              </div>
            ))}
          </div>
        )}
      </AsyncView>
      <LoadMore paged={paged} />
    </>
  );
}

function Settings({ user }: { user: CurrentUser }) {
  const { setMe } = useMe();
  const [nickname, setNickname] = useState(user.nickname);
  const [bio, setBio] = useState(user.bio);
  const [avatar, setAvatar] = useState(user.avatar ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!nickname.trim()) return setMessage({ ok: false, text: '昵称不能为空' });
    setSaving(true);
    setMessage(undefined);
    try {
      setMe(await api.updateMe({ nickname: nickname.trim(), bio: bio.trim(), avatar }));
      setMessage({ ok: true, text: '已保存' });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={save} noValidate>
      <div className="field">
        <label className="field-label" htmlFor="me-nickname">昵称</label>
        <input id="me-nickname" maxLength={PROFILE_LIMITS.nickname} value={nickname} onChange={(event) => setNickname(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="me-bio">简介</label>
        <textarea id="me-bio" rows={3} maxLength={PROFILE_LIMITS.bio} value={bio} onChange={(event) => setBio(event.target.value)} />
      </div>
      <fieldset className="field">
        <legend className="field-label">头像</legend>
        {/* 用「一组开关按钮」而不是 radiogroup：radiogroup 要求方向键导航
            （roving tabindex），只给 role 不给键盘行为反而误导读屏用户。
            这里每个按钮都能 Tab 到、Enter/Space 切换，语义完整。 */}
        <div className="avatar-picker" role="group" aria-label="选择预设头像">
          <button
            type="button" aria-pressed={avatar === ''}
            className={`avatar-option ${avatar === '' ? 'selected' : ''}`}
            onClick={() => setAvatar('')}
          >
            <Avatar nickname={nickname} avatar={avatar || undefined} /> <span>默认</span>
          </button>
          {AVATAR_PRESETS.map((preset) => (
            <button
              key={preset} type="button" aria-pressed={avatar === preset}
              className={`avatar-option ${avatar === preset ? 'selected' : ''}`}
              onClick={() => setAvatar(preset)}
            >
              <AvatarPresetGlyph preset={preset} /> <span>{AVATAR_PRESET_NAMES[preset]}</span>
            </button>
          ))}
        </div>
        <p className="hint">头像是预设图案，不上传文件，也不读取第三方图片。</p>
      </fieldset>
      {message && <p className={message.ok ? 'form-success' : 'form-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      <button type="submit" className="btn btn-red submit-btn" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
    </form>
  );
}

const MIN_PASSWORD = 10;

function ChangePassword() {
  const empty = { current: '', next: '', confirm: '' };
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [saving, setSaving] = useState(false);
  const change = (field: keyof typeof empty, value: string) => setForm((current) => ({ ...current, [field]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    const invalid = !form.current ? '请填写当前密码'
      : form.next.length < MIN_PASSWORD ? `新密码至少 ${MIN_PASSWORD} 位`
        : form.next !== form.confirm ? '两次输入的新密码不一致' : undefined;
    if (invalid) return setMessage({ ok: false, text: invalid });
    setSaving(true);
    setMessage(undefined);
    try {
      await api.changePassword({ currentPassword: form.current, newPassword: form.next });
      setForm(empty);
      setMessage({ ok: true, text: '密码已修改，其他设备已退出登录' });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form settings-password" onSubmit={save} noValidate>
      <h2 className="section-title">修改密码</h2>
      <div className="field">
        <label className="field-label" htmlFor="me-current-password">当前密码</label>
        <input id="me-current-password" type="password" autoComplete="current-password" maxLength={128} value={form.current} onChange={(event) => change('current', event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="me-new-password">新密码</label>
        <input id="me-new-password" type="password" autoComplete="new-password" maxLength={128} value={form.next} onChange={(event) => change('next', event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="me-confirm-password">确认新密码</label>
        <input id="me-confirm-password" type="password" autoComplete="new-password" maxLength={128} value={form.confirm} onChange={(event) => change('confirm', event.target.value)} />
      </div>
      {message && <p className={message.ok ? 'form-success' : 'form-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      <button type="submit" className="btn btn-ghost submit-btn" disabled={saving}>{saving ? '修改中…' : '修改密码'}</button>
    </form>
  );
}

export default function Me() {
  const me = useMe();
  const here = useHere();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(({ value }) => value === params.get('tab'))?.value ?? 'favorites';

  return (
    <section className="module page">
      <title>我的 · 什么值得蹬</title>
      <AsyncView state={me} skeleton={<Skeleton rows={6} />}>
        {(user) => (user === null ? <Empty title="登录后查看个人中心" action={{ to: loginPath(here), label: '登录' }} /> : (
          <>
            <header className="page-head me-head">
              <Avatar nickname={user.nickname} avatar={user.avatar} size={64} />
              <div className="me-head-main">
                <h1 className="page-title">{user.nickname}</h1>
                <p className="page-sub">{user.bio || '这个人还没有写简介'}</p>
              </div>
              <dl className="me-stats">
                <div><dt>Token</dt><dd className="num">{user.tokens}</dd></div>
                <div><dt>连续签到</dt><dd className="num">{user.streak}</dd></div>
                <div><dt>收藏</dt><dd className="num">{user.favoriteCount}</dd></div>
                <div><dt>分享</dt><dd className="num">{user.shareCount}</dd></div>
              </dl>
            </header>
            <div className="tabs tabs-page" role="tablist" aria-label="个人中心">
              {TABS.map(({ value, label }) => (
                <button key={value} type="button" role="tab" className="tab" aria-selected={value === tab} onClick={() => setParams({ tab: value })}>{label}</button>
              ))}
            </div>
            {tab === 'favorites' && <Favorites />}
            {tab === 'posts' && <MyPosts />}
            {tab === 'submissions' && <MySubmissions />}
            {tab === 'notifications' && <MyNotifications />}
            {tab === 'settings' && <><Settings user={user} /><ChangePassword /><AgentTokens key={user.handle} /></>}
            {tab !== 'settings' && <p className="hint me-tip">想分享新的体验？<Link to="/submit">去投稿</Link></p>}
          </>
        ))}
      </AsyncView>
    </section>
  );
}

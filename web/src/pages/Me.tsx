import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { CurrentUser } from '@zhidedeng/shared';
import { api } from '../api';
import AsyncView, { Empty, LoadMore, Skeleton } from '../components/AsyncView';
import PostCard from '../components/PostCard';
import StationCard from '../components/StationCard';
import { Avatar } from '../components/visuals';
import { loginPath } from '../format';
import { usePaged } from '../hooks';
import { useHere, useMe } from '../state';
import AgentTokens from './AgentTokens';

const TABS = [
  { value: 'favorites', label: '我的收藏' },
  { value: 'posts', label: '我的分享' },
  { value: 'settings', label: '账户设置' },
] as const;

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
  return (
    <>
      <AsyncView state={paged} isEmpty={(items) => items.length === 0} empty={<Empty title="还没有分享" action={{ to: '/submit', label: '去投稿' }} />}>
        {(items) => <div className="card-list">{items.map((post) => <PostCard key={post.id} post={post} />)}</div>}
      </AsyncView>
      <LoadMore paged={paged} />
    </>
  );
}

function Settings({ user }: { user: CurrentUser }) {
  const { setMe } = useMe();
  const [nickname, setNickname] = useState(user.nickname);
  const [bio, setBio] = useState(user.bio);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!nickname.trim()) return setMessage({ ok: false, text: '昵称不能为空' });
    setSaving(true);
    setMessage(undefined);
    try {
      setMe(await api.updateMe({ nickname: nickname.trim(), bio: bio.trim() }));
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
        <input id="me-nickname" maxLength={30} value={nickname} onChange={(event) => setNickname(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="me-bio">简介</label>
        <textarea id="me-bio" rows={3} maxLength={200} value={bio} onChange={(event) => setBio(event.target.value)} />
      </div>
      {message && <p className={message.ok ? 'form-success' : 'form-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      <button type="submit" className="btn btn-red submit-btn" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
    </form>
  );
}

const MIN_PASSWORD = 8;

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
              <Avatar nickname={user.nickname} size={64} />
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
            {tab === 'settings' && <><Settings user={user} /><ChangePassword /><AgentTokens key={user.handle} /></>}
            {tab !== 'settings' && <p className="hint me-tip">想分享新的体验？<Link to="/submit">去投稿</Link></p>}
          </>
        ))}
      </AsyncView>
    </section>
  );
}

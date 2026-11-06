import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import { safeNext } from '../format';
import { useMe } from '../state';

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;

/** 回跳地址只接受站内路径；已登录时不停留在表单页。 */
function useAuthPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  return { next, me, nextQuery: next === '/' ? '' : `?next=${encodeURIComponent(next)}` };
}

function Field({ id, label, error, hint, ...input }: {
  id: string; label: string; error?: string; hint?: string;
  value: string; onChange: (value: string) => void; type?: string; autoComplete: string; maxLength?: number;
}) {
  const { value, onChange, ...rest } = input;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} {...rest} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} />
      {error ? <p className="form-error">{error}</p> : hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Login() {
  const { next, me, nextQuery } = useAuthPage();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = { username: username.trim() ? undefined : '请填写用户名', password: password ? undefined : '请填写密码' };
    setErrors(found);
    if (found.username || found.password) return;
    setSubmitting(true);
    setServerError(undefined);
    try {
      me.signIn(await api.login({ username: username.trim(), password }));
      navigate(next, { replace: true });
    } catch (error) {
      setServerError((error as Error).message);
      setSubmitting(false);
    }
  }

  if (me.data && !submitting) return <Navigate to={next} replace />;
  return (
    <section className="module page auth-page">
      <title>登录 · 什么值得蹬</title>
      <header className="page-head"><h1 className="page-title">登录</h1></header>
      <form onSubmit={submit} noValidate>
        <Field id="login-username" label="用户名" autoComplete="username" maxLength={20} value={username} onChange={setUsername} error={errors.username} />
        <Field id="login-password" label="密码" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={setPassword} error={errors.password} />
        {serverError && <p className="form-error" role="alert">{serverError}</p>}
        <button type="submit" className="btn btn-red submit-btn" disabled={submitting}>{submitting ? '登录中…' : '登录'}</button>
      </form>
      <p className="hint auth-switch">还没有账号？<Link to={`/register${nextQuery}`}>去注册</Link></p>
    </section>
  );
}

export function Register() {
  const { next, me, nextQuery } = useAuthPage();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', nickname: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<{ username?: string; password?: string; confirm?: string }>({});
  const [serverError, setServerError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const change = (field: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [field]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const username = form.username.trim();
    const found = {
      username: USERNAME.test(username) ? undefined : '用户名须为 3~20 位字母、数字或下划线',
      password: form.password.length >= MIN_PASSWORD ? undefined : `密码至少 ${MIN_PASSWORD} 位`,
      confirm: form.confirm === form.password ? undefined : '两次输入的密码不一致',
    };
    setErrors(found);
    if (found.username || found.password || found.confirm) return;
    setSubmitting(true);
    setServerError(undefined);
    try {
      me.signIn(await api.register({ username, password: form.password, nickname: form.nickname.trim() || undefined }));
      navigate(next, { replace: true });
    } catch (error) {
      setServerError((error as Error).message);
      setSubmitting(false);
    }
  }

  if (me.data && !submitting) return <Navigate to={next} replace />;
  return (
    <section className="module page auth-page">
      <title>注册 · 什么值得蹬</title>
      <header className="page-head">
        <h1 className="page-title">注册</h1>
        <p className="page-sub">暂不支持找回密码，请妥善保存。</p>
      </header>
      <form onSubmit={submit} noValidate>
        <Field id="register-username" label="用户名" autoComplete="username" maxLength={20} value={form.username} onChange={change('username')} error={errors.username} hint="3~20 位字母、数字或下划线，注册后不能修改" />
        <Field id="register-nickname" label="昵称（可选，可以用中文）" autoComplete="nickname" maxLength={20} value={form.nickname} onChange={change('nickname')} />
        <Field id="register-password" label="密码" type="password" autoComplete="new-password" maxLength={128} value={form.password} onChange={change('password')} error={errors.password} hint={`至少 ${MIN_PASSWORD} 位`} />
        <Field id="register-confirm" label="确认密码" type="password" autoComplete="new-password" maxLength={128} value={form.confirm} onChange={change('confirm')} error={errors.confirm} />
        {serverError && <p className="form-error" role="alert">{serverError}</p>}
        <button type="submit" className="btn btn-red submit-btn" disabled={submitting}>{submitting ? '注册中…' : '注册'}</button>
      </form>
      <p className="hint auth-switch">已有账号？<Link to={`/login${nextQuery}`}>去登录</Link></p>
    </section>
  );
}

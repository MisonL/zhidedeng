import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import { loginPath, SITE_NOTICE } from '../format';
import { useAsync } from '../hooks';
import { useHere, useMe, useToast } from '../state';
import Icon from './Icon';

function HotSearches() {
  const state = useAsync((signal) => api.getHotSearches(signal), []);
  return (
    <div className="hot-searches">
      <span className="hot-label">热门搜索：</span>
      {state.error && <button type="button" className="text-btn" onClick={state.reload}>加载失败，重试</button>}
      {state.data?.items.map((word) => (
        <Link key={word} to={`/search?q=${encodeURIComponent(word)}`}>{word}</Link>
      ))}
    </div>
  );
}

function SiteHeader() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const urlQuery = pathname === '/search' ? params.get('q') ?? '' : '';
  const [query, setQuery] = useState(urlQuery);

  useEffect(() => setQuery(urlQuery), [urlQuery]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (text) navigate(`/search?q=${encodeURIComponent(text)}`);
  }

  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Link className="brand" to="/" aria-label="什么值得蹬 首页">
          <img className="brand-seal" src="/favicon.svg" alt="" width={62} height={62} />
          <span className="brand-text">
            <span className="brand-name">什么值得蹬</span>
            <span className="brand-slogan">我们的AI中转指南</span>
          </span>
        </Link>
        <div className="site-search">
          <form className="search-form" role="search" onSubmit={submit}>
            <input
              type="search" aria-label="搜索模型、厂商、中转站" placeholder="搜索模型、厂商、中转站"
              value={query} onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit">搜索</button>
          </form>
          <HotSearches />
        </div>
      </div>
    </header>
  );
}

function ShareMenu() {
  return (
    <DropMenu label="投稿分享">
      {(close) => (
        <>
          <Link to="/submit?kind=deal" onClick={close}>发爆料</Link>
          <Link to="/submit?kind=review" onClick={close}>写评测</Link>
        </>
      )}
    </DropMenu>
  );
}

function UserMenu({ nickname }: { nickname: string }) {
  const { signOut } = useMe();
  const toast = useToast();
  const navigate = useNavigate();

  async function logout(close: () => void) {
    close();
    try {
      await signOut();
      navigate('/');
    } catch (error) {
      toast((error as Error).message);
    }
  }

  return (
    <DropMenu label={nickname} className="nav-me">
      {(close) => (
        <>
          <Link to="/me" onClick={close}>我的</Link>
          <button type="button" onClick={() => logout(close)}>退出登录</button>
        </>
      )}
    </DropMenu>
  );
}

function DropMenu({ label, className = '', children }: { label: string; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className={`share-menu ${className ? `${className}-menu` : ''}${open ? ' is-open' : ''}`} ref={root}>
      <button type="button" className={`nav-link ${className}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((value) => !value)}>
        <span className="nav-menu-label">{label}</span><Icon name="down" size={14} />
      </button>
      <div className="share-popup">{children(() => setOpen(false))}</div>
    </div>
  );
}

function SiteNav() {
  const me = useMe();
  const here = useHere();
  const link = (extra = '') => ({ isActive }: { isActive: boolean }) => `nav-link${extra}${isActive ? ' is-active' : ''}`;
  return (
    <nav className="site-nav" aria-label="主导航">
      <div className="container site-nav-inner">
        <div className="nav-group">
          <NavLink className={link()} to="/" end>首页</NavLink>
          <NavLink className={link()} to="/models">模型</NavLink>
          <NavLink className={link()} to="/community">社区</NavLink>
          <NavLink className={link()} to="/reviews">评测</NavLink>
        </div>
        <div className="nav-group nav-right">
          <NavLink className={link(' nav-secondary')} to="/docs">API文档</NavLink>
          <NavLink className={link(' nav-secondary')} to="/business">商务合作</NavLink>
          <ShareMenu />
          {me.data && <UserMenu nickname={me.data.nickname} />}
          {me.data === null && (
            <span className="nav-auth">
              <Link className="nav-link" to={loginPath(here)}>登录</Link>
              <span aria-hidden="true">|</span>
              <Link className="nav-link" to="/register">注册</Link>
            </span>
          )}
          {me.error && <button type="button" className="nav-link nav-me" onClick={me.reload}>用户加载失败，重试</button>}
        </div>
      </div>
    </nav>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p className="footer-notice">{SITE_NOTICE}。本站与什么值得买及任何模型厂商、中转站均无关联。</p>
        <p className="footer-links">
          <Link to="/stations">中转站库</Link>
          <Link to="/rank">排行榜</Link>
          <Link to="/models">模型库</Link>
          <Link to="/docs">API 文档</Link>
          <Link to="/business">商务合作</Link>
        </p>
        <p className="hint">什么值得蹬 · 我们的AI中转指南。厂商名称与图标仅作分类标识。</p>
      </div>
    </footer>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const { epoch } = useMe();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <SiteHeader />
      <SiteNav />
      <main className="container site-main"><Outlet key={epoch} /></main>
      <SiteFooter />
    </>
  );
}

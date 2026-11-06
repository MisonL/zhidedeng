import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import type { Post } from '@zhidedeng/shared';
import { api, ApiError } from '../api';
import { useAsync, useCarousel } from '../hooks';
import { loginPath } from '../format';
import { useHere, useMe, useToast } from '../state';
import AsyncView, { Empty, Skeleton } from './AsyncView';
import Icon from './Icon';
import type { IconName } from './Icon';
import { PostCover } from './visuals';

const ROW_ICON: Record<Post['kind'], IconName> = { deal: 'doc', review: 'doc', guide: 'book', community: 'bars' };

/** 每位数字一条 0~9 的纵向带，靠 transform 滚动到目标数字。 */
function TokenOdometer({ value }: { value: number }) {
  const digits = String(value).split('');
  return (
    <span className="odometer num" role="img" aria-label={`Token 余额 ${value}`}>
      {digits.map((digit, position) => (
        <span key={digits.length - position} className="odometer-column">
          <span
            className="odometer-strip"
            style={{ transform: `translateY(-${Number(digit) * 10}%)`, transitionDelay: `${(digits.length - position) * 60}ms` }}
          >
            {'0123456789'.split('').map((item) => <span key={item}>{item}</span>)}
          </span>
        </span>
      ))}
    </span>
  );
}

const COMPACT_QUERY = '(max-width: 760px)';
function watchCompact(notify: () => void) {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}

function MyShares() {
  const state = useAsync((signal) => api.getMyPosts({ pageSize: 6 }, signal), []);
  const posts = state.data?.items ?? [];
  const featuredCount = Math.min(posts.length, 3);
  const { index, goTo, hoverProps } = useCarousel(featuredCount, 4000);

  return (
    <div className="shares" {...hoverProps}>
      <div className="shares-head">
        <h2 className="shares-title">我已经分享</h2>
        {featuredCount > 1 && (
          <div className="mini-dots">
            {posts.slice(0, featuredCount).map((post, slide) => (
              <button
                key={post.id} type="button" className="mini-dot" aria-label={`第 ${slide + 1} 篇分享`}
                aria-current={slide === index} onClick={() => goTo(slide)}
              />
            ))}
          </div>
        )}
      </div>
      <AsyncView
        state={{ data: state.data?.items, error: state.error, reload: state.reload }}
        isEmpty={(items) => items.length === 0}
        skeleton={<Skeleton rows={2} />}
        empty={<Empty title="还没有分享" action={{ to: '/submit', label: '去投稿' }} />}
      >
        {(items) => (
          <>
            <Link key={items[index].id} className="share-feature" to={`/posts/${items[index].id}`}>
              <span className="share-thumb"><PostCover post={items[index]} /></span>
              <span className="share-feature-title">{items[index].title}</span>
            </Link>
            <ul className="share-list">
              {items.filter((_, position) => position !== index).slice(0, 3).map((post) => (
                <li key={post.id}>
                  <Link to={`/posts/${post.id}`}><Icon name={ROW_ICON[post.kind]} size={18} /><span>{post.title}</span></Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </AsyncView>
    </div>
  );
}

function GuestCard() {
  const login = loginPath(useHere());
  return (
    <>
      <span className="user-avatar" role="img" aria-label="默认头像" />
      <p className="user-name">Hi~ 登录发现更多精彩</p>
      <p className="user-greeting">登录后可以投票、收藏、评论和投稿</p>
      <nav className="user-links" aria-label="个人中心">
        <Link to="/register">注册账号</Link>
      </nav>
      <Link className="btn btn-red checkin-btn" to={login}>登录</Link>
      <Link className="btn btn-ghost guest-checkin" to={login}>签到领Token</Link>
    </>
  );
}

export default function UserCard() {
  const me = useMe();
  const toast = useToast();
  const [gain, setGain] = useState<number>();
  // 手机端用户条不放「我已经分享」：按断点不挂载，省掉它的请求和轮播定时器。
  const compact = useSyncExternalStore(watchCompact, () => window.matchMedia(COMPACT_QUERY).matches);

  async function checkIn() {
    const before = me.data!;
    me.setMe({ ...before, checkedInToday: true, streak: before.streak + 1 });
    try {
      const result = await api.checkIn();
      me.setMe({ ...before, tokens: result.tokens, streak: result.streak, checkedInToday: true });
      setGain(result.tokensAwarded);
    } catch (error) {
      toast((error as Error).message);
      me.setMe(before);
      if (error instanceof ApiError && error.code === 'ALREADY_CHECKED_IN') await me.refreshMe();
    }
  }

  return (
    <aside className="user-card" aria-label="当前用户">
      <AsyncView state={me} skeleton={<Skeleton rows={6} />}>
        {(user) => (user === null ? <GuestCard /> : (
          <>
            <div className="token-chip">
              <Icon name="coin" size={14} />
              <TokenOdometer value={user.tokens} />
              <span className="token-gain" role="status" key={gain}>{gain ? `+${gain}` : ''}</span>
            </div>
            <span className="user-avatar" role="img" aria-label={`${user.nickname}的头像`} />
            <p className="user-name">{user.nickname}（{user.handle}）</p>
            <p className="user-greeting">欢迎回来，今天也要蹬得开心</p>
            <nav className="user-links" aria-label="个人中心">
              <Link to="/me?tab=favorites">我的收藏</Link>
              <Link to="/me?tab=posts">我的分享</Link>
              <Link className="is-accent" to="/me?tab=settings">账户设置</Link>
            </nav>
            <button type="button" className="btn btn-red checkin-btn" disabled={user.checkedInToday} onClick={checkIn}>
              {user.checkedInToday
                ? <><Icon name="check" size={18} />已签到<span className="checkin-sep"> · </span><span className="checkin-streak">连续 {user.streak} 天</span></>
                : '签到领Token'}
            </button>
            {!compact && <MyShares />}
          </>
        ))}
      </AsyncView>
    </aside>
  );
}

import { Link, useParams } from 'react-router';
import { api } from '../api';
import AsyncView, { Empty, LoadMore } from '../components/AsyncView';
import PostCard from '../components/PostCard';
import { Avatar } from '../components/visuals';
import { formatDate } from '../format';
import { useAsync, usePaged } from '../hooks';

/**
 * 作者主页。
 *
 * 数据本来就都在（`GET /api/posts?author=` 与 `GET /api/users/:handle`），
 * 不需要新表——所以这里只是把已有的东西排到一个地址上，让别人能引用某个人
 * 写过什么，而不是只能在单篇文章底下看到他的名字。
 */
export default function Author() {
  const { handle = '' } = useParams();
  const profile = useAsync((signal) => api.getUser(handle, signal), [handle]);
  const posts = usePaged((page, signal) => api.getPosts({ author: handle, page, pageSize: 10 }, signal), [handle]);

  return (
    <section className="page">
      <title>{profile.data ? `${profile.data.nickname} 的主页` : '作者主页'} · 什么值得蹬</title>
      <AsyncView state={profile}>
        {(user) => (
          <header className="author-head">
            <Avatar nickname={user.nickname} avatar={user.avatar || undefined} size={56} />
            <div>
              <h1 className="page-title">{user.nickname}</h1>
              <p className="page-sub">{user.bio || '这个人还没有写简介'}</p>
              <p className="hint">
                <span className="num">{user.shareCount}</span> 篇分享
                {' · '}
                <span className="num">{user.upCount}</span> 个赞
                {user.joinedAt && <> · 注册于 <span className="num">{formatDate(user.joinedAt)}</span></>}
              </p>
            </div>
          </header>
        )}
      </AsyncView>

      <h2 className="section-title">TA 的分享</h2>
      <AsyncView
        state={posts}
        isEmpty={(items) => items.length === 0}
        empty={<Empty title="还没有公开的分享" action={{ to: '/community', label: '去社区看看' }} />}
      >
        {(items) => (
          <div className="card-list">
            {items.map(post => <PostCard key={post.id} post={post} />)}
          </div>
        )}
      </AsyncView>
      <LoadMore paged={posts} />
    </section>
  );
}

/** 页面里引用作者时统一走这里，别在各处手拼 `/u/`。 */
export const authorPath = (handle: string) => `/u/${encodeURIComponent(handle)}`;

export function AuthorLink({ handle, nickname }: { handle: string; nickname: string }) {
  return <Link to={authorPath(handle)}>{nickname}</Link>;
}

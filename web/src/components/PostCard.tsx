import { Link } from 'react-router';
import type { PostSummary } from '@zhidedeng/shared';
import { formatDate, formatRate, formatUptime, KIND_LABEL, sourceLabel } from '../format';
import { useCatalog } from '../state';
import FavoriteButton from './FavoriteButton';
import AuthorName from './AuthorName';
import Icon from './Icon';
import { PostCover } from './visuals';
import VoteButtons from './VoteButtons';

export default function PostCard({ post }: { post: PostSummary }) {
  const { stationBySlug, modelBySlug } = useCatalog();
  const station = post.stationSlug ? stationBySlug.get(post.stationSlug) : undefined;
  const model = post.modelSlug ? modelBySlug.get(post.modelSlug) : undefined;
  const postPath = `/posts/${post.id}`;
  const label = sourceLabel(post.source);

  return (
    <article className="post-card">
      <Link className="post-cover" to={postPath} aria-hidden="true" tabIndex={-1}>
        <PostCover post={post} />
      </Link>
      <div className="post-body">
        <h3 className="post-title"><Link to={postPath}>{post.title}</Link></h3>
        {station?.lowestRate != null && (
          <p className="post-rate">{station.name} 低至 {formatRate(station.lowestRate)}</p>
        )}
        <div className="tags">
          <span className={`tag tag-${post.kind}`}>{KIND_LABEL[post.kind]}</span>
          {label && <span className="tag tag-warn">{label}</span>}
          {post.status === 'pending' && <span className="tag tag-warn">审核中</span>}
          {post.status === 'rejected' && <span className="tag tag-warn">未通过</span>}
          {station && <span className="tag">可用率 {formatUptime(station.uptime)}</span>}
          {station?.status === 'unstable' && <span className="tag tag-warn">运行波动</span>}
          {model && <Link className="tag" to={`/models/${model.slug}`}>{model.name}</Link>}
        </div>
        <p className="post-summary">{post.summary}</p>
        {/* 驳回理由只在作者自己的列表里出现（服务端也只对作者返回该字段）。
            之前只显示「未通过」，作者不知道哪里不合格，也没法据此重投。 */}
        {post.status === 'rejected' && post.reviewReason && (
          <p className="post-review-reason">未通过原因：{post.reviewReason}</p>
        )}
        <div className="post-foot">
          <VoteButtons targetType="post" targetId={post.id} votes={post.votes} currentUserVote={post.currentUserVote} />
          <FavoriteButton targetType="post" targetId={post.id} favorited={post.favorited} favoriteCount={post.favoriteCount} />
          <Link className="meta-btn" to={postPath} aria-label={`评论 ${post.commentCount}`}>
            <Icon name="comment" size={15} /><span className="num">{post.commentCount}</span>
          </Link>
          <span className="post-side">
            <time className="num" dateTime={post.publishedAt}>{formatDate(post.publishedAt).slice(5)}</time>
            {station
              ? <Link className="post-source" to={`/stations/${station.slug}`}>{station.name}</Link>
              : <AuthorName author={post.author} />}
            <Link className="btn btn-red btn-small" to={station ? `/stations/${station.slug}` : postPath}>
              去看看<Icon name="right" size={13} />
            </Link>
          </span>
        </div>
      </div>
    </article>
  );
}

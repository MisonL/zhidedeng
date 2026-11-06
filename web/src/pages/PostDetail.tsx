import { Link, useParams } from 'react-router';
import { api } from '../api';
import AsyncView from '../components/AsyncView';
import Comments from '../components/Comments';
import FavoriteButton from '../components/FavoriteButton';
import Markdown from '../components/Markdown';
import { Avatar } from '../components/visuals';
import VoteButtons from '../components/VoteButtons';
import { formatDate, formatRate, KIND_LABEL, SUBMISSION_LABEL } from '../format';
import { useAsync } from '../hooks';
import { useCatalog } from '../state';

export default function PostDetail() {
  const { id = '' } = useParams();
  const state = useAsync((signal) => api.getPost(id, signal), [id]);
  const { stationBySlug, modelBySlug } = useCatalog();

  return (
    <>
      <title>{`${state.data?.title ?? '文章'} · 什么值得蹬`}</title>
      {state.data?.source === 'submission' && <p className="demo-notice" role="note">{SUBMISSION_LABEL}，不构成消费建议</p>}
      {state.data?.status === 'pending' && <p className="demo-notice" role="note">审核中，目前只有你自己看得到</p>}
      {state.data?.status === 'rejected' && <p className="demo-notice" role="note">未通过审核，目前只有你自己看得到</p>}
      <article className="module page article">
        <AsyncView state={state}>
          {(post) => {
            const station = post.stationSlug ? stationBySlug.get(post.stationSlug) : undefined;
            const model = post.modelSlug ? modelBySlug.get(post.modelSlug) : undefined;
            return (
              <>
                <header className="article-head">
                  <span className={`tag tag-${post.kind}`}>{KIND_LABEL[post.kind]}</span>
                  <h1 className="article-title">{post.title}</h1>
                  <p className="article-meta">
                    <Avatar nickname={post.author.nickname} size={24} />
                    <span>{post.author.nickname}</span>
                    <time className="num" dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
                    {station && <Link to={`/stations/${station.slug}`}>{station.name}{station.lowestRate !== null && ` · 低至 ${formatRate(station.lowestRate)}`}</Link>}
                    {model && <Link to={`/models/${model.slug}`}>{model.name}</Link>}
                  </p>
                </header>
                <p className="article-summary">{post.summary}</p>
                {post.source === 'submission'
                  ? <p className="article-plain">{post.body}</p>
                  : <Markdown>{post.body}</Markdown>}
                <footer className="article-foot">
                  <VoteButtons targetType="post" targetId={post.id} votes={post.votes} currentUserVote={post.currentUserVote} />
                  <FavoriteButton targetType="post" targetId={post.id} favorited={post.favorited} favoriteCount={post.favoriteCount} />
                </footer>
              </>
            );
          }}
        </AsyncView>
      </article>
      {state.data && <Comments targetType="post" targetId={id} />}
    </>
  );
}

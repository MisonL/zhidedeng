import { Link } from 'react-router';
import type { Station } from '@zhidedeng/shared';
import { formatLatency, formatRate, formatUptime, SUBMISSION_LABEL } from '../format';
import FavoriteButton from './FavoriteButton';
import Icon from './Icon';
import { StationTile } from './visuals';
import VoteButtons from './VoteButtons';

export default function StationCard({ station }: { station: Station }) {
  const path = `/stations/${station.slug}`;
  return (
    <article className="post-card">
      <Link className="post-cover" to={path} aria-hidden="true" tabIndex={-1}><StationTile station={station} /></Link>
      <div className="post-body">
        <h3 className="post-title"><Link to={path}>{station.name}</Link></h3>
        <p className="post-rate">{station.lowestRate === null ? '暂无报价' : `低至 ${formatRate(station.lowestRate)}`}</p>
        <div className="tags">
          {station.source === 'submission' && <span className="tag tag-warn">{SUBMISSION_LABEL}</span>}
          <span className={station.uptime === null ? 'tag' : 'tag tag-good'}>可用率 {formatUptime(station.uptime)}</span>
          <span className="tag">首 token {formatLatency(station.firstTokenLatencyMs)}</span>
          {station.status === 'unstable' && <span className="tag tag-warn">运行波动</span>}
        </div>
        <p className="post-summary">{station.description}</p>
        <div className="post-foot">
          <VoteButtons targetType="station" targetId={station.slug} votes={station.votes} currentUserVote={station.currentUserVote} />
          <FavoriteButton targetType="station" targetId={station.slug} favorited={station.favorited} favoriteCount={station.favoriteCount} />
          <Link className="meta-btn" to={path} aria-label={`评论 ${station.commentCount}`}>
            <Icon name="comment" size={15} /><span className="num">{station.commentCount}</span>
          </Link>
          <span className="post-side">
            {station.foundedAt && <span className="post-source">成立于 <span className="num">{station.foundedAt.slice(0, 4)}</span></span>}
            <Link className="btn btn-red btn-small" to={path}>去看看<Icon name="right" size={13} /></Link>
          </span>
        </div>
      </div>
    </article>
  );
}

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { GetRankingsResponse, RankingTab } from '@zhidedeng/shared';
import { api } from '../api';
import { formatPercent, formatRate } from '../format';
import { useAsync } from '../hooks';
import AsyncView from './AsyncView';
import { ExpertTile, ModelTile, PostCover } from './visuals';

const TABS: { value: RankingTab; label: string }[] = [
  { value: 'model', label: '模型' },
  { value: 'community', label: '社区' },
  { value: 'expert', label: '达人' },
];

function RankCard({ rank, to, art, title, highlight }: {
  rank: number; to?: string; art: ReactNode; title: string; highlight: string;
}) {
  const body = (
    <>
      <span className="rank-art">
        {art}
        {rank <= 3 ? <span className={`rank-ribbon rank-top-${rank} num`}>TOP {rank}</span> : <span className="rank-number num">{rank}</span>}
      </span>
      <span className="rank-title">{title}</span>
      <span className="rank-highlight">{highlight}</span>
    </>
  );
  return <li>{to ? <Link className="rank-card" to={to}>{body}</Link> : <div className="rank-card">{body}</div>}</li>;
}

function RankCards({ data }: { data: GetRankingsResponse }) {
  if (data.tab === 'model') {
    return data.items.map(({ rank, model, lowestRate, stationCount }) => (
      <RankCard
        key={model.slug} rank={rank} to={`/models/${model.slug}`} art={<ModelTile model={model} />} title={model.name}
        highlight={lowestRate === null ? '暂无报价' : `低至 ${formatRate(lowestRate)} · ${stationCount} 站可选`}
      />
    ));
  }
  if (data.tab === 'community') {
    return data.items.map(({ rank, post }) => (
      <RankCard
        key={post.id} rank={rank} to={`/posts/${post.id}`} art={<PostCover post={post} />} title={post.title}
        highlight={`值 ${formatPercent(post.votes.upRatio)} · ${post.votes.total} 票`}
      />
    ));
  }
  return data.items.map(({ rank, user, shareCount, upCount }) => (
    <RankCard
      key={user.handle} rank={rank}
      art={<ExpertTile nickname={user.nickname} />}
      title={user.nickname} highlight={`分享 ${shareCount} · 获值 ${upCount}`}
    />
  ));
}

interface RankingBoardProps {
  /** 受控模式由 /rank 页把 tab 写进 URL；首页不传时自管。 */
  tab?: RankingTab;
  onTabChange?: (tab: RankingTab) => void;
  pageSize?: number;
  heading?: 'h1' | 'h2';
}

export default function RankingBoard({ tab: controlled, onTabChange, pageSize = 6, heading: Heading = 'h2' }: RankingBoardProps) {
  const [own, setOwn] = useState<RankingTab>('model');
  const tab = controlled ?? own;
  const state = useAsync((signal) => api.getRankings({ tab, pageSize }, signal), [tab, pageSize]);

  return (
    <section className="module" aria-label="排行榜">
      <header className="module-head">
        <Heading className="module-title">排行榜</Heading>
        <div className="tabs" role="tablist" aria-label="榜单类型">
          {TABS.map(({ value, label }) => (
            <button
              key={value} type="button" role="tab" className="tab" aria-selected={value === tab}
              onClick={() => { setOwn(value); onTabChange?.(value); }}
            >
              {label}
            </button>
          ))}
        </div>
        {!controlled && <Link className="module-more" to={`/rank?tab=${tab}`}>查看更多</Link>}
      </header>
      <AsyncView
        state={state}
        skeleton={<ol className="rank-grid " aria-busy="true">{Array.from({ length: 6 }, (_, index) => <li key={index} className="rank-placeholder" />)}</ol>}
      >
        {(data) => <ol className="rank-grid"><RankCards data={data} /></ol>}
      </AsyncView>
    </section>
  );
}

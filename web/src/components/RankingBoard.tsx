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
        // 「低至 0.4x · 5 站可选」读起来像「5 个站都能拿到 0.4x」，但 stationCount
        // 数的是**所有口径**的报价站数，而 0.4x 只来自综合口径。5 站里可能只有 2 站
        // 报的是综合价。改成「有报价」，只陈述「这些站在报这个模型」，不暗示都能拿到这个价。
        highlight={lowestRate === null ? '暂无报价' : `低至 ${formatRate(lowestRate)} · ${stationCount} 站有报价`}
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
        // 空库时这里原来渲染一个空的 .rank-grid——首页最显眼的模块是个白块，
        // 看起来像坏了。榜单没有数据是正常状态（真实内容还没起来），
        // 所以给一句话说清「为什么空」和「能做什么」。
        // 返回的是 {items,total,tab} 而不是数组，默认的空态判定（看数组长度）不生效，
        // 必须显式给 isEmpty，否则空库时那段文案永远不出现。
        isEmpty={(data) => data.items.length === 0}
        empty={(
          <p className="state">
            {tab === 'model'
              ? <>目录里还没有模型，模型榜暂时为空。 <Link to="/submit?kind=model">补录一个模型</Link></>
              : tab === 'community'
                ? <>还没有已通过的社区文章，社区榜暂时为空。 <Link to="/submit?kind=community">写第一篇</Link></>
                : <>还没有人分享过内容，达人榜暂时为空。 <Link to="/submit">去写第一篇</Link></>}
          </p>
        )}
      >
        {(data) => <ol className="rank-grid"><RankCards data={data} /></ol>}
      </AsyncView>
    </section>
  );
}

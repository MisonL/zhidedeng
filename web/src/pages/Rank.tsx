import { useSearchParams } from 'react-router';
import type { RankingTab } from '@zhidedeng/shared';
import RankingBoard from '../components/RankingBoard';

const TABS: RankingTab[] = ['model', 'community', 'expert'];

export default function Rank() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as RankingTab;
  const tab = TABS.includes(requested) ? requested : 'model';

  return (
    <>
      <title>排行榜 · 什么值得蹬</title>
      <RankingBoard tab={tab} onTabChange={(next) => setParams({ tab: next })} pageSize={12} heading="h1" />
    </>
  );
}

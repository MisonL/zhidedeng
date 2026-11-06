import type { PostKind } from '@zhidedeng/shared';
import Feed, { FeedSidebar } from '../components/Feed';

export default function FeedPage({ title, kind }: { title: string; kind: PostKind }) {
  return (
    <>
      <title>{`${title} · 什么值得蹬`}</title>
      <div className="feed-layout">
        <Feed title={title} heading="h1" kind={kind} />
        <FeedSidebar />
      </div>
    </>
  );
}

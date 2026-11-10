import type { AdminDisableUserResponse, PostStatus } from '@zhidedeng/shared';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';
import { reviewSubmission } from './submissions.ts';

// 管理接口的动作，由 app.ts 在 Bearer 校验之后调用。没有后台页面，运维用 curl。

export function listPosts(store: Store, status: PostStatus) {
  const items = store.all('post').filter(post => post.status === status)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .map(({ id, kind, title, summary, body, authorHandle, stationSlug, modelSlug, publishedAt, status: current }) => ({ id, kind, title, summary, body, authorHandle, stationSlug, modelSlug, publishedAt, status: current }));
  // 站内投稿已进统一队列，物化前只在 submissions 里，不列出来审核员就看不到。
  const queued = store.db.prepare(
    "SELECT * FROM submissions WHERE kind = 'post' AND channel = 'web' AND status = ? ORDER BY createdAt",
  ).all(status).map(row => {
    const payload = JSON.parse(row.payload as string) as { kind: string; title: string; summary: string; body: string; stationSlug: string | null; modelSlug: string | null };
    return { id: row.id as string, ...payload, authorHandle: row.actorHandle as string | null, publishedAt: row.createdAt as string, status };
  });
  return { items: [...items, ...queued].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)) };
}

export function reviewPost(store: Store, now: () => Date, id: string, status: PostStatus) {
  const post = store.get('post', id);
  if (!post) {
    // 站内投稿还在队列里：交给统一的审核函数，物化和状态推进都在那里。
    const row = store.db.prepare(
      "SELECT 1 FROM submissions WHERE id = ? AND kind = 'post' AND channel = 'web' AND status = 'pending'",
    ).get(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    const reviewed = reviewSubmission(store, now(), id, { status: status === 'approved' ? 'approved' : 'rejected' });
    return { id, status: reviewed.status as PostStatus };
  }
  // 群友提交的文章由飞书全量同步写入，这里改了下次同步又会恢复。
  // agent 和用户自己的投稿不受此限：前者没有二次同步，后者本来就归站内管，
  // 而且这里是它们唯一的下架路径（队列只处理待审记录）。
  if (post.source === 'submission') throw new ApiError(409, 'MANAGED_BY_SOURCE', '这是群友提交的内容，请到飞书表格撤销「通过」后重新同步');
  store.put('post', id, { ...post, status });
  return { id, status };
}

/** 禁用后所有会话立即失效，公开内容保留；恢复后要重新登录。 */
export function setAccountDisabled(store: Store, handle: string, disabled: boolean, now: Date): AdminDisableUserResponse {
  const account = store.db.prepare('SELECT handle FROM accounts WHERE usernameKey = ?').get(handle.toLowerCase());
  if (!account) throw new ApiError(404, 'NOT_FOUND', '账号不存在');
  const found = account.handle as string;
  return store.transaction(() => {
    store.db.prepare('UPDATE accounts SET disabledAt = ? WHERE handle = ?').run(disabled ? now.toISOString() : null, found);
    if (disabled) {
      store.db.prepare('DELETE FROM sessions WHERE handle = ?').run(found);
      // Agent 凭证必须一并吊销。禁用期间它被 accounts.disabledAt IS NULL 挡住，
      // 但只删会话不吊销凭证的话，账号恢复那一刻旧 token 就原样复活了——
      // 攻击者不用重新认证，而管理员以为「禁用」已经切断了他的访问。
      // 只吊销没吊销过的，保留首次吊销时间供审计。
      // agent_tokens 表在凭证分支才引入，这里按表存在与否决定是否执行。
      const hasTokens = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_tokens'").get();
      if (hasTokens) store.db.prepare('UPDATE agent_tokens SET revokedAt = ? WHERE handle = ? AND revokedAt IS NULL').run(now.toISOString(), found);
    }
    return { handle: found, disabled };
  });
}

export function setCommentHidden(store: Store, id: string, hidden: boolean) {
  if (!store.db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id)) throw new ApiError(404, 'NOT_FOUND', '评论不存在');
  store.db.prepare('UPDATE comments SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  return { id, hidden };
}

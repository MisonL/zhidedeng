import type { AdminDisableUserResponse, Post, PostStatus } from '@zhidedeng/shared';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';
import { appendLedger, balanceOf } from './tokens.ts';
import { comparePublishedAt } from './service.ts';
import { reviewSubmission } from './submissions.ts';

// 管理接口的动作，由 app.ts 在 Bearer 校验之后调用。
// 常规审核走 /admin 页面；这里保留成纯函数，是为了让 curl 和运维脚本也能直接调，
// 且业务逻辑不依赖 HTTP 层（测试可以绕过路由直接测）。

export function listPosts(store: Store, status: PostStatus) {
  const items = store.all('post').filter(post => post.status === status)
    .sort((a, b) => comparePublishedAt(a.publishedAt, b.publishedAt))
    .map(({ id, kind, title, summary, body, authorHandle, stationSlug, modelSlug, publishedAt, status: current, contentVersion }) => ({
      id, kind, title, summary, body, authorHandle, stationSlug, modelSlug, publishedAt, status: current,
      // 版本号决定「撤销上次修改」按钮出不出来。
      contentVersion: contentVersion ?? 1,
    }));
  // 站内投稿已进统一队列，物化前只在 submissions 里，不列出来审核员就看不到。
  // 排除已物化的：物化时 post id 就是 submission id，两边都查会列出同一条两次。
  const queued = store.db.prepare(
    "SELECT * FROM submissions WHERE kind = 'post' AND channel = 'web' AND status = ? AND NOT EXISTS (SELECT 1 FROM entities WHERE kind = 'post' AND entities.id = submissions.id) ORDER BY createdAt",
  ).all(status).map(row => {
    const payload = JSON.parse(row.payload as string) as { kind: string; title: string; summary: string; body: string; stationSlug: string | null; modelSlug: string | null };
    const targetPostId = (row.targetPostId as string | null) ?? null;
    if (!targetPostId) {
      return {
        id: row.id as string, ...payload, authorHandle: row.actorHandle as string | null,
        publishedAt: row.createdAt as string, status, editOf: null, targetTitle: null,
        changedFields: [] as string[], contentVersion: 1,
      };
    }
    // 编辑某篇文章的投稿：审核员要一眼看出「这是某篇的新版本」，而不是以为
    // 又冒出一篇新文章。顺便把哪几个字段变了算出来——不做字符级 diff，
    // 「标题/正文变了」这种粒度足够审核员决定要不要细看。
    const live = store.get('post', targetPostId);
    const changedFields = live === undefined ? [] : (['title', 'summary', 'body', 'stationSlug', 'modelSlug'] as const)
      .filter(field => (live[field] ?? null) !== (payload[field] ?? null));
    return {
      id: row.id as string, ...payload, authorHandle: row.actorHandle as string | null,
      publishedAt: row.createdAt as string, status,
      editOf: targetPostId, targetTitle: live?.title ?? null, changedFields,
      contentVersion: live?.contentVersion ?? 1,
    };
  }).filter(item => item.editOf === null || status === 'pending');
  // 已审核过的编辑不是「一篇文章」，不该出现在文章列表里；只有待审的才需要
  // 审核员看见（上面 filter 只放行 pending 的编辑行）。
  return { items: [...items, ...queued].sort((a, b) => comparePublishedAt(a.publishedAt, b.publishedAt)) };
}

export function reviewPost(store: Store, now: () => Date, id: string, status: PostStatus, reason?: string) {
  const post = store.get('post', id);
  if (!post) {
    // 站内投稿还在队列里：交给统一的审核函数，物化和状态推进都在那里。
    const row = store.db.prepare(
      "SELECT 1 FROM submissions WHERE id = ? AND kind = 'post' AND channel = 'web' AND status = 'pending'",
    ).get(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    const reviewed = reviewSubmission(store, now(), id, {
      status: status === 'approved' ? 'approved' : 'rejected',
      // 理由要一路带到 submissions.reason，作者才能在「我的投稿」里看到为什么被拒。
      ...(reason ? { reason } : {}),
    });
    return { id, status: reviewed.status as PostStatus };
  }
  // 群友提交的文章由飞书全量同步写入，直接改状态下次同步就白改了。
  // 但原来的报错把管理员指向了一条走不通的路：让去飞书撤销「通过」再同步——
  // 撤销只会让这条记录从批次里消失，一个不存在的记录生成不了下架请求。
  // 所以这里改成真的下架（软删除，同步不会再复活，见 materialize 里的守卫）。
  if (post.source === 'submission' && status === 'rejected') {
    // 先把理由写进实体，再下架。以前只调 withdrawPost，强制填的理由成了一次性
    // 废纸：管理员自己事后都看不到，更别说作者。reviewReason 与 status 无关，
    // 恢复后仍可读，这正是「说明为什么被拒」需要的语义。
    store.put('post', id, { ...post, reviewReason: reason ?? null });
    withdrawPost(store, id, now().toISOString());
    return { id, status };
  }
  // 理由随记录一起存。已通过时清空：一篇后来过审的文章不该还挂着旧的驳回理由，
  // 否则作者在详情页会同时看到「已通过」和「未通过原因」。
  store.put('post', id, { ...post, status, reviewReason: status === 'rejected' ? (reason ?? null) : null });
  // 站内投稿物化后 entities.id === submissions.id。两个页签各读一处，
  // 只改 entities 会让「我的分享」说 rejected、「我的投稿」说 approved，
  // 理由也只对一边可见。把终态同步回 submissions，让两边同一口径。
  // 用 status = 'approved'/'rejected' 直接对齐；未命中 submissions 的
  // （演示/直接建的实体）没有这一行，update 影响 0 条也无害。
  const sync = store.db.prepare(
    "UPDATE submissions SET status = ?, reason = ?, reviewedAt = ? WHERE id = ? AND kind = 'post' AND channel = 'web' AND status IN ('approved','rejected')",
  ).run(status, status === 'rejected' ? (reason ?? null) : null, now().toISOString(), id) as { changes?: number };
  // web 渠道的文章被改判 rejected 时，与它有关的待审修改一并作废：
  // 文章已经不在线，那条修改审也审不过去（物化会 409 POST_NOT_PUBLISHED），
  // 留着只会占配额、让作者空等。
  if (status === 'rejected') rejectPendingEdits(store, id, now().toISOString(), '文章被改判未通过，这次修改作废');
  // 返回值里多带一个 synced 仅供测试与调用方确认两边已对齐；
  // API 契约仍是 {id,status}，app.ts 会原样返回它（多余字段无害）。
  return { id, status, synced: Number(sync.changes ?? 0) > 0 };
}

/**
 * 下架一篇已发布的文章（管理员）。
 *
 * 和站点的下架一样是软删除：数据留着，随时能恢复，前台立刻看不见。
 *
 * 这里不区分来源。「请去飞书撤销后重新同步」曾经是唯一的撤回路径，但它对
 * 群友来源根本走不通——同步脚本只处理审核状态为「通过」的记录，撤销「通过」
 * 只会让这条记录**不再出现在批次里**，一个已经不存在的记录无法生成任何
 * 下架请求。实测：撤销后重同步，文章原样在线。所以管理员必须有一个直接的
 * 下架入口；materialize 那边也加了守卫，防止下一次同步把它复活。
 */
/**
 * 作废某篇文章待审的修改。
 *
 * 文章下线后，那条「修改审核中」就永远审不过了（物化时会 409）。留着它有三个
 * 坏处：作者在编辑器里看到「审核中」等一个不会来的结果、占着该作者的待审配额、
 * 管理员审核台里挂一条点了必然失败的条目。所以下架时一并落终态，理由写清楚。
 */
export function rejectPendingEdits(store: Store, postId: string, reviewedAt: string, reason: string): void {
  store.db.prepare(
    "UPDATE submissions SET status = 'rejected', reason = ?, reviewedAt = ? WHERE targetPostId = ? AND status = 'pending'",
  ).run(reason.slice(0, 1000), reviewedAt, postId);
}

export function withdrawPost(store: Store, id: string, removedAt: string): { id: string; removed: true } {
  // 用 getWithRemoved：已经下架的也要认出来，报「已下架」而不是「不存在」。
  // 用 get 的话重复点一次会得到 404，管理员会以为这篇没了。
  const post = store.getWithRemoved('post', id);
  if (!post) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
  // 演示数据和站点侧是同一套规矩（removeStation 拒绝 source='demo'）：
  // 那些是虚构样例，撤掉只会让站点看起来像坏了，而它们本来也不承载任何真实信息。
  if (post.source === 'demo') throw new ApiError(409, 'POST_SOURCE_CONFLICT', '演示数据不能下架');
  // 状态与流水必须同一个事务：只改状态不记流水，通知就永久缺一条，
  // 而重试会撞 ALREADY_REMOVED（状态已经是下架），补不回来。
  store.transaction(() => {
    if (!store.markRemoved('post', id, removedAt)) throw new ApiError(409, 'ALREADY_REMOVED', '该文章已下架，不需要重复操作');
    recordPostEvent(store, id, post.authorHandle, 'removed', removedAt, null, post.title);
    // 待审的修改一并作废：文章都不在线了，那条修改审也审不过去。
    rejectPendingEdits(store, id, removedAt, '文章已下架，这次修改作废');
  });
  return { id, removed: true };
}

/** 恢复被下架的文章，只清软删除标记，正文一直是原样保留的。 */
export function restorePost(store: Store, id: string, now = () => new Date()): { id: string; restored: true } {
  const post = store.getWithRemoved('post', id);
  if (!post) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
  store.transaction(() => {
    if (!store.restore('post', id)) throw new ApiError(409, 'ALREADY_ONLINE', '该文章当前在线，不需要恢复');
    recordPostEvent(store, id, post.authorHandle, 'restored', now().toISOString(), null, post.title);
  });
  return { id, restored: true };
}

/**
 * 记一条文章下架/恢复流水，供「我的通知」读取。
 *
 * 为什么必须单独记：`entities.removedAt` 只存当前状态，恢复时会被清空，
 * 「你的文章被恢复了」这条通知就等于没有来源。流水只增不改。
 * 演示数据也会产生流水，但它们的作者是 demo- 前缀的虚构账号，读通知的人
 * 不会是它们；真实账号不会去关注演示文章。
 */
export function recordPostEvent(
  store: Store, postId: string, authorHandle: string, action: 'removed' | 'restored',
  at: string, reason: string | null, title: string | null,
) {
  store.db.prepare('INSERT INTO post_events (postId, authorHandle, action, reason, title, at) VALUES (?,?,?,?,?,?)')
    .run(postId, authorHandle, action, reason, title, at);
}

/** 禁用后所有会话立即失效，公开内容保留；恢复后要重新登录。 */
/**
 * 撤销最近一次「编辑上线」：把文章退回上一版。
 *
 * 误批是真实会发生的（审核台一条一条点，编辑稿和普通投稿长得很像）。没有这条
 * 回退路径，唯一的补救就是「下架」，等于把一个误操作变成一次内容删除——
 * 作者看到的是文章没了，而不是「改回原样」。
 *
 * 只回退**最近一次**且尚未回退过的编辑；回退本身也升一版（v+1），这样
 * 「改过才能再报」和「更新于」仍然成立，也不会把举报快照搅乱。
 */
export function revertRevision(store: Store, postId: string, now: Date) {
  const at = now.toISOString();
  return store.transaction(() => {
    const post = store.get('post', postId);
    if (!post) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    const row = store.db.prepare(
      `SELECT id, previousPayload FROM submissions
        WHERE targetPostId = ? AND status = 'approved' AND previousPayload IS NOT NULL
        ORDER BY reviewedAt DESC, rowid DESC LIMIT 1`,
    ).get(postId) as { id: string; previousPayload: string } | undefined;
    if (!row) throw new ApiError(409, 'NOTHING_TO_REVERT', '这篇文章没有可回退的修改');
    const previous = JSON.parse(row.previousPayload) as {
      kind: Post['kind']; title: string; summary: string; body: string;
      stationSlug: string | null; modelSlug: string | null;
    };
    store.put('post', postId, {
      ...post,
      kind: previous.kind, title: previous.title, summary: previous.summary, body: previous.body,
      stationSlug: previous.stationSlug, modelSlug: previous.modelSlug,
      contentVersion: (post.contentVersion ?? 1) + 1, revisedAt: at,
    });
    // 清掉这一份，避免同一次编辑被反复「回退」成同一个旧版。
    store.db.prepare('UPDATE submissions SET previousPayload = NULL WHERE id = ?').run(row.id);
    return { postId, restoredVersion: (post.contentVersion ?? 1) + 1, title: previous.title };
  });
}

/**
 * 管理员直接加减 Token。
 *
 * 只给了「补发」和「扣回」两种用途，都要写理由：流水就是审计日志，一条没有
 * 理由的负数事后没人解释得清。扣到负数直接拒绝——余额是余额，不是信用额度。
 */
export function adjustTokens(store: Store, handle: string, input: { delta: number; memo: string }, now: Date) {
  const account = store.db.prepare('SELECT handle FROM accounts WHERE usernameKey = ?').get(handle.toLowerCase()) as
    { handle: string } | undefined;
  if (!account) throw new ApiError(404, 'NOT_FOUND', '账号不存在');
  const memo = input.memo.trim();
  if (!memo) throw new ApiError(400, 'INVALID_INPUT', '必须填写理由，流水就是审计日志');
  return store.transaction(() => {
    const entry = appendLedger(store, {
      handle: account.handle, delta: input.delta, reason: input.delta > 0 ? 'admin_grant' : 'admin_deduct',
      memo: memo.slice(0, 200), at: now.toISOString(),
    });
    return { handle: account.handle, balance: entry.balanceAfter, entry };
  });
}

/**
 * 管理员查看已注销账号。
 *
 * 只读、只列墓碑行。不做「代用户注销」——那需要一个能代持的凭据，而站点不收
 * 邮箱，没有可替代的确认方式。恢复是唯一的管理动作，见 restoreAccount。
 */
export function listDeletedAccounts(store: Store) {
  const rows = store.db.prepare(
    'SELECT handle, createdAt, deletedAt FROM accounts WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC',
  ).all() as Array<{ handle: string; createdAt: string; deletedAt: string }>;
  return {
    items: rows.map(row => ({
      handle: row.handle, createdAt: row.createdAt, deletedAt: row.deletedAt,
      // 文章数用 entities 按作者统计：内容是被保留的，管理员要能判断「这个人走了
      // 之后站里还剩什么」。
      postCount: Number(store.db.prepare(
        `SELECT count(*) AS count FROM entities WHERE kind = 'post' AND json_extract(data,'$.authorHandle') = ? AND removedAt IS NULL`,
      ).get(row.handle)!.count),
    })),
  };
}

/**
 * 管理员恢复一个已注销的账号。
 *
 * 只清 deletedAt 并重建 user 行（昵称回落为 handle）：投票、收藏、签到在注销时
 * 已经删掉，找不回来；文章与评论一直在，恢复后署名会变回正常昵称。
 * 不还原旧昵称——它已经从库里删了，凭空造一个只会让人以为「什么都没发生」。
 */
export function restoreAccount(store: Store, handle: string, now: Date): { handle: string; restored: true } {
  const account = store.db.prepare('SELECT handle, deletedAt FROM accounts WHERE usernameKey = ?').get(handle.toLowerCase()) as
    { handle: string; deletedAt: string | null } | undefined;
  if (!account) throw new ApiError(404, 'NOT_FOUND', '账号不存在');
  if (account.deletedAt === null) throw new ApiError(409, 'ALREADY_ACTIVE', '这个账号没有注销，不需要恢复');
  store.transaction(() => {
    store.db.prepare('UPDATE accounts SET deletedAt = NULL WHERE handle = ?').run(account.handle);
    // user 实体行在注销时删掉了，恢复时必须重建，否则 /api/me 会走 requireUser 的
    // 自动重建分支（昵称=handle、tokens 初始值），看起来像「凭空多了一笔 Token」。
    if (!store.get('user', account.handle)) {
      // 余额必须从流水回填，不能写 0：账本一直在（注销不清账本），写 0 会让
      // /api/me 显示 0 而 Token 页显示真实余额，送花还会被判「不够」。
      store.put('user', account.handle, {
        handle: account.handle, nickname: account.handle, avatar: '', bio: '',
        tokens: balanceOf(store, account.handle),
      });
      // 徽章按兑换单重建：注销时清了权益、账本与单据都留着（审计），
      // 不重建的话用户花 240 买的东西在「注销→恢复」之后凭空消失，
      // 而当月的兑换记录还会让重买先撞月配额——永久失去且当月自愈不了。
      const badge = store.db.prepare(
        "SELECT 1 FROM redemptions WHERE handle = ? AND itemKey = 'badge' LIMIT 1",
      ).get(account.handle);
      if (badge) {
        store.db.prepare('INSERT OR IGNORE INTO entitlements (handle, key, grantedAt) VALUES (?, ?, ?)')
          .run(account.handle, 'supporter', now.toISOString());
      }
    }
  });
  void now;
  return { handle: account.handle, restored: true };
}

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

/** 举报的展示行。管理台一次看一条，同时带出被举报对象是否还在线。 */
export interface ReportRow {
  id: string;
  targetType: 'post' | 'station' | 'comment';
  targetId: string;
  reporterHandle: string;
  reason: string;
  detail: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: string;
  handledAt: string | null;
  /** 被举报对象当前是否仍然可见。已下架的再处理一次没有意义。 */
  targetAlive: boolean;
  /** 展示用的一句摘要（文章标题/站点名/评论正文前 40 字）。 */
  targetLabel: string;
  /**
   * 举报发生时文章是第几版（举报那一刻的快照）。非文章目标为 null。
   * 与 currentVersion 一起看：两者不同说明「被举报的内容已经改过了」，
   * 审核员不该拿新版内容去判断旧版的问题。
   */
  targetVersion: number | null;
  /** 文章此刻的版本号。 */
  currentVersion: number | null;
}

/**
 * 举报列表：**游标分页 + 两批查询**。
 *
 * 两处都是踩过的坑：
 *
 * 1. 游标而不是 offset。offset 分页在「翻页期间有人新提交举报」时会整体错位：
 *    第 2 页会重复第 1 页的最后一条，而真正该出现的那条永远看不到（实测漏过）。
 *    游标用 (createdAt, rowid) 定位「从哪之后继续」，插入新行不改变已有位置。
 * 2. 目标状态一次查完。原来对每一行分别 getWithRemoved + removedAt（一条举报两次
 *    点查），举报攒到几十条就是上百次查询；现在整个一页最多 3 次：post 与 station
 *    合并成一条 entities 的 IN，评论一条 comments 的 IN。
 *
 * 游标编码成 `<createdAt>|<rowid>`，不含用户可控内容，只用来定位。
 */
export interface ReportPage {
  items: ReportRow[];
  total: number;
  pageSize: number;
  /** 下一页的游标；null 表示没有更多。 */
  nextCursor: string | null;
}

export function listReports(
  store: Store,
  status: 'open' | 'resolved' | 'dismissed' = 'open',
  pageSize = 20,
  cursor?: string | null,
): ReportPage {
  const total = Number((store.db.prepare('SELECT count(*) AS count FROM reports WHERE status = ?').get(status) as { count: number }).count);

  const after = parseCursor(cursor);
  const rows = (after === null
    ? store.db.prepare(
      `SELECT rowid, id,targetType,targetId,reporterHandle,reason,detail,status,createdAt,handledAt,targetVersion
       FROM reports WHERE status = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
    ).all(status, pageSize)
    : store.db.prepare(
      `SELECT rowid, id,targetType,targetId,reporterHandle,reason,detail,status,createdAt,handledAt,targetVersion
       FROM reports WHERE status = ? AND (createdAt < ? OR (createdAt = ? AND rowid < ?))
       ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
    ).all(status, after.createdAt, after.createdAt, after.rowid, pageSize)) as unknown as Array<
      Omit<ReportRow, 'targetAlive' | 'targetLabel'> & { rowid: number }>;

  const idsOf = (type: string) => [...new Set(rows.filter(row => row.targetType === type).map(row => row.targetId))];
  const postIds = idsOf('post');
  const stationIds = idsOf('station');
  const commentIds = idsOf('comment');
  const inList = (ids: readonly string[]) => ids.map(() => '?').join(', ');

  // post 与 station 都是 entities 里的行，一次查完两种 kind。
  const entityInfo = new Map<string, { alive: boolean; label: string; version: number | null }>();
  const entityIds = [...postIds, ...stationIds];
  if (entityIds.length > 0) {
    const found = store.db.prepare(
      `SELECT kind, id, data, removedAt FROM entities WHERE kind IN ('post','station') AND id IN (${inList(entityIds)})`,
    ).all(...entityIds) as Array<{ kind: string; id: string; data: string; removedAt: string | null }>;
    for (const row of found) {
      const data = JSON.parse(row.data) as { title?: string; name?: string; contentVersion?: number };
      entityInfo.set(`${row.kind}:${row.id}`, {
        alive: row.removedAt === null,
        label: (row.kind === 'post' ? data.title : data.name) ?? row.id,
        // 当前是第几版：举报如果对着旧版提的，审核员得知道「现在看到的已经不是
        // 被举报的那一版」，否则会按新版内容下判断。
        version: row.kind === 'post' ? (data.contentVersion ?? 1) : null,
      });
    }
  }
  const commentInfo = new Map<string, { alive: boolean; label: string; version: number | null }>();
  if (commentIds.length > 0) {
    const found = store.db.prepare(
      `SELECT id, content, hidden, deletedAt FROM comments WHERE id IN (${inList(commentIds)})`,
    ).all(...commentIds) as Array<{ id: string; content: string; hidden: number; deletedAt: string | null }>;
    for (const comment of found) {
      commentInfo.set(comment.id, {
        alive: comment.hidden === 0 && comment.deletedAt === null,
        label: comment.content.slice(0, 40) || '（已删除的评论）',
        version: null,
      });
    }
  }

  const items = rows.map(({ rowid: _rowid, ...row }) => {
    const info = row.targetType === 'post'
      ? entityInfo.get(`post:${row.targetId}`)
      : row.targetType === 'station' ? entityInfo.get(`station:${row.targetId}`) : commentInfo.get(row.targetId);
    // 查不到 = 对象已经不在库里。这仍然是「不在线」，标签回落到 id 而不是留空，
    // 让审核员一眼看出这是个已经消失的对象。
    return {
      ...row, targetAlive: info?.alive ?? false, targetLabel: info?.label ?? row.targetId,
      targetVersion: row.targetVersion ?? null,
      // 举报时是第 N 版、现在第 M 版：两者不同说明内容已经改过。
      currentVersion: info?.version ?? null,
    };
  });

  const last = rows.at(-1);
  return {
    items,
    total,
    pageSize,
    nextCursor: rows.length === pageSize && last !== undefined ? `${last.createdAt}|${last.rowid}` : null,
  };
}

function parseCursor(cursor?: string | null): { createdAt: string; rowid: number } | null {
  if (!cursor) return null;
  const index = cursor.lastIndexOf('|');
  if (index <= 0) return null;
  const createdAt = cursor.slice(0, index);
  const rowid = Math.trunc(Number(cursor.slice(index + 1)));
  if (!Number.isFinite(rowid)) return null;
  return { createdAt, rowid };
}

/**
 * 处置一条举报：`resolved` = 已处理（内容可能已下架），`dismissed` = 看过但不认为有问题。
 *
 * **只改举报自身的状态，不动被举报内容。** 下架是另一个动作（withdrawPost /
 * removeStation），需要管理员再点一次——把「有人举报」直接变成「内容下架」
 * 等于把删帖权交给任何点按钮的人。
 */
export function resolveReport(store: Store, now: () => Date, id: string, status: 'resolved' | 'dismissed', note?: string) {
  const row = store.db.prepare('SELECT status, targetType, targetId FROM reports WHERE id = ?').get(id) as
    { status: string; targetType: string; targetId: string } | undefined;
  if (!row) throw new ApiError(404, 'NOT_FOUND', '举报不存在');
  if (row.status !== 'open') throw new ApiError(409, 'ALREADY_HANDLED', '这条举报已经处理过了');
  // 处置时把目标内容的版本号一起记下。只有文章有版本；站点/评论不可编辑，
  // 记 NULL 即可（`createReport` 对 NULL 维持「一律拦」的老行为）。
  //
  // 这里**不**用处置时刻的最新版本：管理员可能是半小时前打开页面看的 v3，
  // 期间 v4 已经上线，等他点「驳回举报」时记成 v4——之后 v4 再出现同样的问题
  // 就被永久拦住，而管理员从没看过 v4。真正要看的是「举报发生时那一版」，
  // 也就是写进这条举报的 targetVersion（见 createReport 的 INSERT）。
  store.db.prepare('UPDATE reports SET status = ?, handledAt = ?, note = ? WHERE id = ?')
    .run(status, now().toISOString(), note?.trim().slice(0, 500) ?? null, id);
  return { id, status };
}

import { randomUUID } from 'node:crypto';
import type { TokenLedgerEntry, TokenRedemption, TokenShopItem } from '@zhidedeng/shared';
import { ApiError } from './errors.ts';
import type { Store } from './database.ts';
import type { SqlRow } from './database.ts';

/**
 * Token 消耗：买什么、花多少、什么时候不许花。
 *
 * 一条硬规矩：**只卖不改变内容准入的东西**。买排名、买审核通过、买举报优先、
 * 「认证」标记、置顶评论一律不做——一旦能买，榜单和审核就不再是「每个人的
 * 真实体验」，那正是这个站唯一值钱的地方。这里的四样都只影响「自己看得见的
 * 体验」：给别人的文章送一朵花、给自己挂个徽章、导出自己的数据、补一次签到。
 *
 * 第二硬规矩：价格别定在「一个月攒不起」也「一天就能买光」。签到满勤月入
 * 约 609，所以最高档 240（徽章）要攒两周左右，最低档 5（一朵花）随时可以。
 */
export const TOKEN_ITEMS: TokenShopItem[] = [
  {
    key: 'flower', name: '送一朵花', cost: 5, unit: '朵',
    description: '给一篇你喜欢的文章送一朵花，作者会收到通知。一朵花 5 Token，每天最多送 50 朵，每月最多 20 朵。',
    monthlyLimit: 20, dailyLimit: 50, requiresTarget: 'post',
  },
  {
    key: 'badge', name: '支持者徽章', cost: 240, unit: '枚',
    description: '永久挂在你的个人主页上。只是好看，不代表任何内容特权，也不影响榜单。',
    monthlyLimit: 1, requiresTarget: null,
  },
  {
    key: 'export', name: '导出我的数据', cost: 30, unit: '次',
    description: '把自己发过的文章、评论和一句话反馈导出成 JSON。每月 2 次。',
    monthlyLimit: 2, requiresTarget: null,
  },
  {
    key: 'makeup', name: '补签卡', cost: 30, unit: '张',
    description: '补上昨天漏掉的一次签到，保住连续天数。只补昨天，不补 Token（漏签那天本来就没挣到）。',
    monthlyLimit: 1, requiresTarget: 'date',
  },
];

export type TokenItemKey = 'flower' | 'badge' | 'export' | 'makeup';

export function itemOf(key: string): TokenShopItem {
  const item = TOKEN_ITEMS.find(candidate => candidate.key === key);
  if (!item) throw new ApiError(400, 'INVALID_INPUT', `没有「${key}」这个兑换项`);
  return item;
}

/** 当前余额：流水最后一行的 balanceAfter。没有任何流水时是 0。 */
export function balanceOf(store: Store, handle: string): number {
  const row = store.db.prepare(
    'SELECT balanceAfter FROM token_ledger WHERE handle = ? ORDER BY rowid DESC LIMIT 1',
  ).get(handle) as { balanceAfter: number } | undefined;
  return row?.balanceAfter ?? 0;
}

/**
 * 记一笔流水并把余额写回 user 缓存。**必须在事务里调用**——余额是读-改-写，
 * 两个并发请求各自读到同一个旧余额就会丢一笔。
 */
export function appendLedger(store: Store, input: {
  handle: string;
  delta: number;
  reason: TokenLedgerEntry['reason'];
  memo?: string | null;
  onceKey?: string | null;
  at: string;
}): TokenLedgerEntry {
  if (input.delta === 0) throw new ApiError(400, 'INVALID_INPUT', '流水金额不能为 0');
  const before = balanceOf(store, input.handle);
  const after = before + input.delta;
  if (after < 0) throw new ApiError(409, 'INSUFFICIENT_TOKENS', `Token 不够：当前 ${before}，需要 ${-input.delta}`);
  const entry: TokenLedgerEntry = {
    id: randomUUID(), handle: input.handle, delta: input.delta, balanceAfter: after,
    reason: input.reason, memo: input.memo ?? null, at: input.at,
  };
  try {
    store.db.prepare(
      'INSERT INTO token_ledger (id,handle,delta,balanceAfter,reason,memo,onceKey,at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(entry.id, entry.handle, entry.delta, entry.balanceAfter, entry.reason, entry.memo, input.onceKey ?? null, input.at);
  } catch (error) {
    // 幂等键撞了：同一个来源事件已经入过账。调用方按「已经记过」处理即可，
    // 这里不当作错误——重放一次签到应该安静地什么都不发生。
    //
    // 只认 onceKey 那个索引：`token_ledger(handle, onceKey)` 是唯一约束，
    // 而 id 主键冲突意味着别的东西出了问题（随机 UUID 撞了？），那必须抛出去，
    // 静默返回一条根本没写进库的流水会让余额悄悄对不上。
    const message = String((error as Error).message);
    if (message.includes('UNIQUE constraint failed: token_ledger.handle, token_ledger.onceKey')) {
      // 回读已经存在的**那一行**，而不是返回刚算出来、根本没写进库的 entry：
      // 那条 entry 的 balanceAfter 带着本次 delta，直接返回会给出一个幻影余额
      // （实测「注销→恢复→同日签到」响应说 782，账本里还是 771）。
      const existing = store.db.prepare(
        'SELECT * FROM token_ledger WHERE handle = ? AND onceKey = ?',
      ).get(input.handle, input.onceKey ?? '') as SqlRow | undefined;
      if (!existing) throw error;
      // 同一个来源事件、金额却不同：说明有一处的计算变了（或有人手工补过）。
      // 静默按旧金额返回会让调用方以为「这次发放成功了」，而库里根本没这笔。
      if ((existing.delta as number) !== input.delta) {
        throw new ApiError(409, 'LEDGER_CONFLICT',
          `这个来源已经记过 ${existing.delta}，本次是 ${input.delta}，拒绝重复入账`);
      }
      // 顺手把缓存拉回账本：冲突分支跳过了下面的缓存写入，不补的话
      // user.tokens 会一直停在旧值上（实测 /api/me 与 Token 页对不上）。
      const cached = store.get('user', input.handle);
      if (cached && cached.tokens !== existing.balanceAfter) {
        store.put('user', input.handle, { ...cached, tokens: existing.balanceAfter as number });
      }
      return {
        id: existing.id as string, handle: existing.handle as string, delta: existing.delta as number,
        balanceAfter: existing.balanceAfter as number, reason: existing.reason as TokenLedgerEntry['reason'],
        memo: (existing.memo as string | null) ?? null, at: existing.at as string,
      };
    }
    throw error;
  }
  // user.tokens 只是缓存：真正的余额以上面的流水为准。行不存在时不重建
  // （已注销或未初始化的账号不该因为记一笔流水而凭空出现）。
  const user = store.get('user', input.handle);
  if (user) store.put('user', input.handle, { ...user, tokens: after });
  return entry;
}

export function ledgerOf(store: Store, handle: string, page: number, pageSize: number): {
  items: TokenLedgerEntry[]; total: number; page: number; pageSize: number;
} {
  const total = Number(store.db.prepare('SELECT count(*) AS count FROM token_ledger WHERE handle = ?').get(handle)!.count);
  const rows = store.db.prepare(
    'SELECT * FROM token_ledger WHERE handle = ? ORDER BY rowid DESC LIMIT ? OFFSET ?',
  ).all(handle, pageSize, (page - 1) * pageSize) as SqlRow[];
  return {
    items: rows.map(row => ({
      id: row.id as string, handle: row.handle as string, delta: row.delta as number,
      balanceAfter: row.balanceAfter as number, reason: row.reason as TokenLedgerEntry['reason'],
      memo: (row.memo as string | null) ?? null, at: row.at as string,
    })),
    total, page, pageSize,
  };
}

/**
 * 上海时区某个自然月的 UTC 区间 [start, end)。
 *
 * 不能用 `substr(createdAt,1,7)` 比月份：createdAt 存的是 UTC，上海 11 月 1 日
 * 04:00 对应 UTC 10 月 31 日 20:00，按字符串比会被算进上个月——月初的额度就
 * 要多等 8 小时才恢复，而用户完全看不出为什么。
 * 上海无夏令时，固定 +08:00，区间端点可以直接写死偏移。
 */
export function shanghaiMonthRange(now: Date): { start: string; end: string } {
  const [year, month] = shanghaiDay.format(now).split('-').map(Number);
  const pad = (value: number) => String(value).padStart(2, '0');
  const start = new Date(`${year}-${pad(month)}-01T00:00:00+08:00`);
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const end = new Date(`${nextMonth.year}-${pad(nextMonth.month)}-01T00:00:00+08:00`);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** 上海时区某一天（含 now 那天）的 UTC 区间 [start, end)。 */
export function shanghaiDayRange(now: Date): { start: string; end: string } {
  const date = shanghaiDay.format(now);
  const start = new Date(`${date}T00:00:00+08:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

/** 本月（上海时区自然月）某个兑换项已经用了几次。 */
export function monthlyUsed(store: Store, handle: string, itemKey: string, now: Date): number {
  const { start, end } = shanghaiMonthRange(now);
  return Number(store.db.prepare(
    'SELECT count(*) AS count FROM redemptions WHERE handle = ? AND itemKey = ? AND createdAt >= ? AND createdAt < ?',
  ).get(handle, itemKey, start, end)!.count);
}

/**
 * 某位作者今天（上海时区）收到的花的朵数。
 *
 * 必须按**接收者**统计而不是按文章：按文章算的话，同一个人换着文章送就能绕开
 * 当天的上限。「作者」从文章实体上取，不额外存一份——存了就会和文章的实际
 * 作者不一致（文章不能转让，但历史数据可能被手工改过）。
 */
export function flowersToAuthorToday(store: Store, authorHandle: string, now: Date): number {
  const { start, end } = shanghaiDayRange(now);
  return Number(store.db.prepare(
    `SELECT count(*) AS count FROM redemptions r
       JOIN entities p ON p.kind = 'post' AND p.id = r.targetId
      WHERE r.itemKey = 'flower' AND json_extract(p.data,'$.authorHandle') = ?
        AND r.createdAt >= ? AND r.createdAt < ?`,
  ).get(authorHandle, start, end)!.count);
}

/** 当天某个兑换项已经用了几次（用来给「每天最多收到 50 朵花」这类上限计数）。 */
export function dailyCount(store: Store, column: 'handle' | 'targetId', value: string, itemKey: string, now: Date): number {
  const { start, end } = shanghaiDayRange(now);
  return Number(store.db.prepare(
    `SELECT count(*) AS count FROM redemptions WHERE itemKey = ? AND ${column} = ? AND createdAt >= ? AND createdAt < ?`,
  ).get(itemKey, value, start, end)!.count);
}

export const shanghaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function redemptionOf(row: SqlRow): TokenRedemption {
  return {
    id: row.id as string, itemKey: row.itemKey as string, cost: row.cost as number,
    targetType: (row.targetType as string | null) ?? null, targetId: (row.targetId as string | null) ?? null,
    payload: row.payload === null ? null : JSON.parse(row.payload as string) as unknown,
    createdAt: row.createdAt as string,
  };
}

/** 兑换结果里那笔「发生了什么」的说明，前端直接展示，不进库。 */
export interface RedeemOutcome {
  order: TokenRedemption;
  balance: number;
  /** 额外的人话说明（补签补的是哪天、花送给谁）。 */
  message: string;
}

/**
 * 兑换一次。
 *
 * 整个流程必须在一个 BEGIN IMMEDIATE 里：查余额、查配额、写兑换单、写流水，
 * 任何一步落到事务外，两个并发请求就可能各自通过「余额够」然后一起扣。
 *
 * 幂等：`(handle, idempotencyKey)` 唯一。同一个键重放返回**原来那张单**，
 * 而不是报错——网络重试不该变成「你已经兑换过了，钱照扣但没东西」。
 * 同一个键换个 itemKey 才是冲突（客户端串号了，必须让它知道）。
 */
export function redeem(store: Store, handle: string, input: {
  itemKey: string; idempotencyKey: string; targetId?: string;
}, now: Date): RedeemOutcome {
  const item = itemOf(input.itemKey);
  const at = now.toISOString();
  // 补签的目标是「昨天」，缺省时就填上再比幂等键：否则同一个键重放时
  // input.targetId 是 undefined、原单里是具体日期，会被判成「串号冲突」。
  const normalizedTarget = item.key === 'makeup' && !input.targetId
    ? shanghaiDay.format(new Date(now.getTime() - 86_400_000))
    : input.targetId;
  return store.transaction(() => {
    const replay = store.db.prepare(
      'SELECT * FROM redemptions WHERE handle = ? AND idempotencyKey = ?',
    ).get(handle, input.idempotencyKey) as SqlRow | undefined;
    if (replay) {
      // 项目相同但目标不同也算冲突：同一个键换一篇文章送花，如果按旧单返回，
      // 用户以为花送到了新的那篇，实际上什么都没发生。
      if (replay.itemKey !== input.itemKey || ((replay.targetId as string | null) ?? null) !== (normalizedTarget ?? null)) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这个请求编号已经用在别的兑换上了，请换一个');
      }
      // 同一张单重放：余额按当前值返回，不再扣钱。
      // 导出这一项要**重新生成**内容：库里只存了摘要，把摘要当原包给回去
      // 等于告诉用户「这是你上次那份」，其实什么都没有。重生成不花钱。
      const replayed = redemptionOf(replay);
      const order = replay.itemKey === 'export'
        ? { ...replayed, payload: exportSnapshot(store, handle) }
        : replayed;
      return { order, balance: balanceOf(store, handle), message: replayMessage(replay) };
    }

    const used = monthlyUsed(store, handle, item.key, now);
    if (used >= item.monthlyLimit) {
      throw new ApiError(429, 'MONTHLY_LIMIT', `${item.name}每月最多 ${item.monthlyLimit} 次，本月已经用完了`);
    }

    // 各兑换项自己的规则。集中在这里而不是散到调用方：兑换是唯一入口，
    // 规则偏离入口一步就会有一条通道绕过它。
    let targetType: string | null = null;
    let targetId: string | null = null;
    let payload: unknown = null;
    let message = '';
    /** 导出这类「内容只在这次响应里给一次」的完整结果，不落库。 */
    let exported: unknown = null;

    if (item.key === 'flower') {
      if (!input.targetId) throw new ApiError(400, 'INVALID_INPUT', '送花要指明送给哪篇文章');
      const post = store.get('post', input.targetId);
      if (!post || post.status !== 'approved') throw new ApiError(404, 'NOT_FOUND', '文章不存在或还没上线');
      if (post.authorHandle === handle) throw new ApiError(409, 'SELF_TIP', '不能给自己的文章送花');
      // 作者已经注销：花送出去没人收得到（通知走「给作者看」的那条路，作者
      // 登不进来），等于白花 5 个 Token。直接说清楚，别让用户自己猜。
      if (!store.get('user', post.authorHandle)) {
        throw new ApiError(409, 'AUTHOR_GONE', '这篇文章的作者已经注销了，送花没人能收到');
      }
      // 一篇一人一朵：不让同一个人把一篇文章刷成一排花。
      const already = store.db.prepare(
        "SELECT 1 FROM redemptions WHERE handle = ? AND itemKey = 'flower' AND targetId = ?",
      ).get(handle, input.targetId);
      if (already) throw new ApiError(409, 'ALREADY_TIPPED', '你已经给这篇文章送过花了');
      // **按作者**每天最多 50 朵，不是按文章：一天只限一篇的话，给同一个人换 51
      // 篇文章各送一朵就绕开了（实测能到 51 朵）。这是防刷，不是惩罚——一个人一天
      // 收 50 朵已经很多了。
      if (flowersToAuthorToday(store, post.authorHandle, now) >= 50) {
        throw new ApiError(429, 'RECIPIENT_LIMIT', '这位作者今天收到的花已经够多了，明天再来吧');
      }
      targetType = 'post'; targetId = input.targetId;
      message = `已经送了《${post.title}》一朵花`;
    } else if (item.key === 'badge') {
      const existing = store.db.prepare('SELECT 1 FROM entitlements WHERE handle = ? AND key = ?').get(handle, 'supporter');
      if (existing) throw new ApiError(409, 'ALREADY_OWNED', '你已经有这枚徽章了');
      // 账号满 3 天才能买：注册当天就能买的「永久徽章」等于给刷号的人一个标记，
      // 而它本身没有任何功能，纯粹是给自己看的。
      const account = store.db.prepare('SELECT createdAt FROM accounts WHERE handle = ?').get(handle) as { createdAt: string } | undefined;
      if (!account) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
      if (now.getTime() - new Date(account.createdAt).getTime() < 3 * 86_400_000) {
        throw new ApiError(403, 'ACCOUNT_TOO_NEW', '注册满 3 天才能购买徽章');
      }
      store.db.prepare('INSERT INTO entitlements (handle, key, grantedAt) VALUES (?, ?, ?)').run(handle, 'supporter', at);
      message = '徽章已经挂在你的主页上了';
    } else if (item.key === 'export') {
      // 落库只存摘要：兑换单是长期保留的审计记录，把整份导出正文永久存进去
      // 等于在库里又抄一份用户内容（还包含已删除的评论墓碑）。正文只在这次
      // 响应里给一次，用户自己保存。
      const snapshot = exportSnapshot(store, handle);
      payload = {
        generatedAt: at,
        postCount: snapshot.posts.length,
        commentCount: snapshot.comments.length,
        feedbackCount: snapshot.feedback.length,
      };
      message = '数据已经打包好，可以直接保存';
      // 完整内容随响应返回，不进库（见上）。
      exported = snapshot;
    } else {
      // makeup：只补昨天，且必须是真的漏签了。
      const yesterday = shanghaiDay.format(new Date(now.getTime() - 86_400_000));
      targetType = 'date'; targetId = normalizedTarget ?? yesterday;
      if (targetId !== yesterday) throw new ApiError(400, 'INVALID_INPUT', '补签卡只能补昨天');
      const filled = store.db.prepare('SELECT 1 FROM checkins WHERE userHandle = ? AND date = ?').get(handle, targetId);
      if (filled) throw new ApiError(409, 'ALREADY_CHECKED_IN', '昨天已经签到过了，不需要补签');
      // 补签只恢复连续天数，不补发那天的 Token：漏签那天本来就没挣到，
      // 用完卡又拿到币，等于签到可以花钱买，签到榜就没意义了。
      const today = shanghaiDay.format(now);
      const dayBefore = shanghaiDay.format(new Date(now.getTime() - 2 * 86_400_000));
      // 前一天（补签的锚点）必须真的签过，否则补了也只是凭空多一条记录。
      const anchor = store.db.prepare('SELECT date, streak FROM checkins WHERE userHandle = ? AND date = ?')
        .get(handle, dayBefore) as { date: string; streak: number } | undefined;
      if (!anchor) throw new ApiError(409, 'STREAK_UNRECOVERABLE', '再往前一天也没签到，连续天数已经断了，补不回来');
      store.db.prepare('INSERT INTO checkins (userHandle, date, tokensAwarded, streak) VALUES (?, ?, 0, ?)')
        .run(handle, targetId, anchor.streak + 1);
      // 今天已经签过、但当时是按「断掉」算的（streak 从 1 开始）：补完昨天要把它
      // 一并接上，否则页面上会出现「补签成功，连续还是 1」这种自相矛盾的显示。
      const todayRow = store.db.prepare('SELECT streak FROM checkins WHERE userHandle = ? AND date = ?')
        .get(handle, today) as { streak: number } | undefined;
      // 只修「今天是从 1 重新开始」这一种：todayRow.streak === 1 说明今天签到时
      // 前面是断的。其它任何值都不该动——用「<= anchor+2」会把手工修过的、
      // 或历史遗留的更高连续数强行压低/抬高（实测能造出 3/4/9 这种脏数据）。
      if (todayRow && todayRow.streak === 1) {
        store.db.prepare('UPDATE checkins SET streak = ? WHERE userHandle = ? AND date = ?')
          .run(anchor.streak + 2, handle, today);
      }
      message = `已经补上 ${targetId} 的签到，连续天数接上了`;
    }

    const order: TokenRedemption = {
      id: randomUUID(), itemKey: item.key, cost: item.cost,
      targetType, targetId, payload, createdAt: at,
    };
    store.db.prepare(
      'INSERT INTO redemptions (id,handle,itemKey,idempotencyKey,cost,targetType,targetId,payload,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(order.id, handle, order.itemKey, input.idempotencyKey, order.cost, targetType, targetId,
      payload === null ? null : JSON.stringify(payload), at);
    // 先写兑换单再扣钱：两条都在同一个事务里，顺序不影响原子性，但这样
    // 「余额不足」抛出时，前面的 insert 会随事务一起回滚（见调用方的 transaction）。
    const entry = appendLedger(store, {
      handle, delta: -item.cost, reason: 'redeem', memo: `${item.name}（${item.cost} Token）`, at,
    });
    // 导出：响应里给完整内容（只此一次），库里只有摘要（见上）。
    const responseOrder = exported === null ? order : { ...order, payload: exported };
    return { order: responseOrder, balance: entry.balanceAfter, message };
  });
}

function replayMessage(row: SqlRow): string {
  const key = row.itemKey as string;
  if (key === 'flower') return '这次送花已经生效过了（同一请求重放，没有重复扣费）';
  if (key === 'badge') return '这枚徽章已经在你名下了（同一请求重放，没有重复扣费）';
  if (key === 'export') return '数据仍然是你上次导出的那一份';
  return `已经补过 ${(row.targetId as string | null) ?? ''} 的签到了（没有重复扣费）`;
}

/**
 * 导出快照：只导出「自己写的」内容。
 *
 * 不含别人的评论、不含投票给谁——那些是别人和站点的数据，导出自己的内容
 * 才是这个功能的用途（换站、备份、或者只是想留一份）。
 */
function exportSnapshot(store: Store, handle: string): { handle: string; posts: unknown[]; comments: unknown[]; feedback: unknown[] } {
  const posts = store.db.prepare(
    "SELECT data FROM entities WHERE kind = 'post' AND json_extract(data,'$.authorHandle') = ? AND removedAt IS NULL ORDER BY rowid",
  ).all(handle).map(row => {
    const post = JSON.parse(row.data as string) as
      { id: string; title: string; summary: string; body: string; publishedAt: string; status?: string };
    // 带上 status：被管理员改判 rejected 的文章不该和正常上线的混在一起看不出来，
    // 导出的是「我写过的东西」，用户要能分辨哪几篇现在还在线上。
    return {
      id: post.id, title: post.title, summary: post.summary, body: post.body,
      publishedAt: post.publishedAt, status: post.status ?? 'approved',
    };
  });
  const comments = store.db.prepare(
    // 排除墓碑与隐藏：导出的应该是「我写过的话」，不是被我自己删掉的占位行，
    // 也不是被管理员隐藏的内容（那已经不算公开内容了）。
    'SELECT targetType, targetId, content, createdAt FROM comments WHERE userHandle = ? AND deletedAt IS NULL AND hidden = 0 ORDER BY rowid',
  ).all(handle) as Array<{ targetType: string; targetId: string; content: string; createdAt: string }>;
  const feedback = store.db.prepare(
    'SELECT stationSlug, verdict, content, createdAt FROM feedback WHERE userHandle = ? AND deletedAt IS NULL ORDER BY rowid',
  ).all(handle) as Array<{ stationSlug: string; verdict: string; content: string; createdAt: string }>;
  return { handle, posts, comments, feedback };
}

/** 已获得的持久权益（徽章 key 列表）。 */
export function entitlementsOf(store: Store, handle: string): string[] {
  return (store.db.prepare('SELECT key FROM entitlements WHERE handle = ? ORDER BY grantedAt').all(handle) as Array<{ key: string }>)
    .map(row => row.key);
}

/**
 * 老库迁移：把 `user.tokens` 里已有的余额补成账本的首条流水。
 *
 * 引入账本之前余额只存在 entities 的 user 行里。升级之后余额一律从流水派生，
 * 不给老用户补这一条，他们的余额就会变成 0——第一次签到还会把缓存写成「0 + 奖励」，
 * 看着像凭空被清空。补一条 `admin_grant` 并注明来源，对账时能一眼看出来。
 *
 * 幂等：只在该 handle 完全没有流水时补，所以可以每次启动都跑。
 */
export function seedTokenLedger(store: Store, now: Date): number {
  const users = store.db.prepare(
    "SELECT data FROM entities WHERE kind = 'user' AND removedAt IS NULL",
  ).all() as Array<{ data: string }>;
  let seeded = 0;
  store.transaction(() => {
    for (const row of users) {
      const user = JSON.parse(row.data) as { handle?: string; tokens?: number };
      const handle = user.handle;
      const tokens = user.tokens ?? 0;
      if (!handle || !Number.isInteger(tokens) || tokens <= 0) continue;
      const existing = store.db.prepare('SELECT 1 FROM token_ledger WHERE handle = ? LIMIT 1').get(handle);
      if (existing) continue;
      store.db.prepare(
        'INSERT INTO token_ledger (id,handle,delta,balanceAfter,reason,memo,onceKey,at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(randomUUID(), handle, tokens, tokens, 'admin_grant', '历史余额迁移（账本上线前）', null, now.toISOString());
      seeded += 1;
    }
  });
  return seeded;
}

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
    if (String((error as Error).message).includes('UNIQUE constraint failed: token_ledger')) return entry;
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

/** 本月（上海时区自然月）某个兑换项已经用了几次。 */
export function monthlyUsed(store: Store, handle: string, itemKey: string, now: Date): number {
  const prefix = shanghaiMonth.format(now);
  return Number(store.db.prepare(
    "SELECT count(*) AS count FROM redemptions WHERE handle = ? AND itemKey = ? AND substr(createdAt, 1, 7) = ?",
  ).get(handle, itemKey, prefix)!.count);
}

/** 当天某个兑换项已经用了几次（用来给「每天最多收到 50 朵花」这类上限计数）。 */
export function dailyCount(store: Store, column: 'handle' | 'targetId', value: string, itemKey: string, now: Date): number {
  const prefix = shanghaiDay.format(now);
  // 2026-11 的上海时间是 UTC+8，`substr(createdAt,1,10)` 拿的是 UTC 日期，
  // 跨过 16:00Z 就会差一天。所以存的是 UTC 时间，比较时先换成上海日期。
  const rows = store.db.prepare(
    `SELECT createdAt FROM redemptions WHERE itemKey = ? AND ${column} = ?`,
  ).all(itemKey, value) as Array<{ createdAt: string }>;
  return rows.filter(row => shanghaiDay.format(new Date(row.createdAt)) === prefix).length;
}

export const shanghaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const shanghaiMonth = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
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
  return store.transaction(() => {
    const replay = store.db.prepare(
      'SELECT * FROM redemptions WHERE handle = ? AND idempotencyKey = ?',
    ).get(handle, input.idempotencyKey) as SqlRow | undefined;
    if (replay) {
      if (replay.itemKey !== input.itemKey) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这个请求编号已经用在别的兑换上了，请换一个');
      }
      // 同一张单重放：余额按当前值返回，不再扣钱。
      return { order: redemptionOf(replay), balance: balanceOf(store, handle), message: replayMessage(replay) };
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

    if (item.key === 'flower') {
      if (!input.targetId) throw new ApiError(400, 'INVALID_INPUT', '送花要指明送给哪篇文章');
      const post = store.get('post', input.targetId);
      if (!post || post.status !== 'approved') throw new ApiError(404, 'NOT_FOUND', '文章不存在或还没上线');
      if (post.authorHandle === handle) throw new ApiError(409, 'SELF_TIP', '不能给自己的文章送花');
      // 一篇一人一朵：不让同一个人把一篇文章刷成一排花。
      const already = store.db.prepare(
        "SELECT 1 FROM redemptions WHERE handle = ? AND itemKey = 'flower' AND targetId = ?",
      ).get(handle, input.targetId);
      if (already) throw new ApiError(409, 'ALREADY_TIPPED', '你已经给这篇文章送过花了');
      // 作者每天最多收到 50 朵：这是防刷，不是惩罚——一个人一天被同一个号刷 20 朵
      // 已经够了，不设上限的话排行榜式的「花最多的文章」会被一个人刷出来。
      if (dailyCount(store, 'targetId', input.targetId, 'flower', now) >= 50) {
        throw new ApiError(429, 'RECIPIENT_LIMIT', '这篇文章今天收到的花已经够多了，明天再来吧');
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
      payload = exportSnapshot(store, handle);
      message = '数据已经打包好，可以直接保存';
    } else {
      // makeup：只补昨天，且必须是真的漏签了。
      const yesterday = shanghaiDay.format(new Date(now.getTime() - 86_400_000));
      targetType = 'date'; targetId = input.targetId ?? yesterday;
      if (targetId !== yesterday) throw new ApiError(400, 'INVALID_INPUT', '补签卡只能补昨天');
      const filled = store.db.prepare('SELECT 1 FROM checkins WHERE userHandle = ? AND date = ?').get(handle, targetId);
      if (filled) throw new ApiError(409, 'ALREADY_CHECKED_IN', '昨天已经签到过了，不需要补签');
      // 补签只恢复连续天数，不补发那天的 Token：漏签那天本来就没挣到，
      // 用完卡又拿到币，等于签到可以花钱买，签到榜就没意义了。
      const last = store.db.prepare(
        'SELECT date, streak FROM checkins WHERE userHandle = ? ORDER BY date DESC LIMIT 1',
      ).get(handle) as { date: string; streak: number } | undefined;
      const dayBefore = shanghaiDay.format(new Date(now.getTime() - 2 * 86_400_000));
      // 只有「昨天之前那天签过」才算接得上连续；否则补了也只是凭空多一条记录。
      if (!last || last.date !== dayBefore) {
        throw new ApiError(409, 'STREAK_UNRECOVERABLE', '再往前一天也没签到，连续天数已经断了，补不回来');
      }
      store.db.prepare('INSERT INTO checkins (userHandle, date, tokensAwarded, streak) VALUES (?, ?, 0, ?)')
        .run(handle, targetId, last.streak + 1);
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
    return { order, balance: entry.balanceAfter, message };
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
function exportSnapshot(store: Store, handle: string): unknown {
  const posts = store.db.prepare(
    "SELECT data FROM entities WHERE kind = 'post' AND json_extract(data,'$.authorHandle') = ? AND removedAt IS NULL ORDER BY rowid",
  ).all(handle).map(row => {
    const post = JSON.parse(row.data as string) as { id: string; title: string; summary: string; body: string; publishedAt: string };
    return { id: post.id, title: post.title, summary: post.summary, body: post.body, publishedAt: post.publishedAt };
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

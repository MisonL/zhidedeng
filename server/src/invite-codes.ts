import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';

/** 邀请码明文只在签发那一刻返回一次；库里只留哈希与前缀。 */
const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');

export interface InviteCodeRecord {
  id: string;
  codePrefix: string;
  note: string | null;
  maxUses: number | null;
  usedCount: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface InviteCodeInput {
  note?: string;
  /** 最多可用次数。不填表示不限次数，但仍受吊销与有效期约束。 */
  maxUses?: number | null;
  expiresAt?: string | null;
}

const MAX_NOTE = 100;
const MAX_USES_LIMIT = 10_000;

export function createInviteCode(store: Store, input: InviteCodeInput, now: Date): { code: string; record: InviteCodeRecord } {
  const note = input.note?.trim() ?? '';
  if (note.length > MAX_NOTE) throw new ApiError(400, 'INVALID_INPUT', `备注最多 ${MAX_NOTE} 个字符`);
  const maxUses = input.maxUses ?? null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_LIMIT)) {
    throw new ApiError(400, 'INVALID_INPUT', `可用次数必须是 1～${MAX_USES_LIMIT} 的整数`);
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null) {
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) throw new ApiError(400, 'INVALID_INPUT', '有效期不是合法时间');
    if (parsed <= now.getTime()) throw new ApiError(400, 'INVALID_INPUT', '有效期必须晚于当前时间');
  }
  // 32 字节随机数的 base64url，足够防止猜测。
  const code = 'zdi_' + randomBytes(32).toString('base64url');
  const record: InviteCodeRecord = {
    id: randomUUID(), codePrefix: code.slice(0, 10) + '\u2026', note: note || null,
    maxUses, usedCount: 0, createdAt: now.toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), revokedAt: null,
  };
  store.db.prepare('INSERT INTO invite_codes (id, codeHash, codePrefix, note, maxUses, usedCount, createdAt, expiresAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(record.id, codeHash(code), record.codePrefix, record.note, record.maxUses, record.usedCount, record.createdAt, record.expiresAt, record.revokedAt);
  return { code, record };
}

export function listInviteCodes(store: Store): InviteCodeRecord[] {
  return store.db.prepare('SELECT id, codePrefix, note, maxUses, usedCount, createdAt, expiresAt, revokedAt FROM invite_codes ORDER BY createdAt DESC, rowid DESC')
    .all() as unknown as InviteCodeRecord[];
}

export function revokeInviteCode(store: Store, id: string, now: Date): InviteCodeRecord {
  const row = store.db.prepare('SELECT id, codePrefix, note, maxUses, usedCount, createdAt, expiresAt, revokedAt FROM invite_codes WHERE id = ?').get(id) as InviteCodeRecord | undefined;
  if (!row) throw new ApiError(404, 'NOT_FOUND', '邀请码不存在');
  // 幂等：重复吊销不该报错，保留第一次吊销的时间。
  if (row.revokedAt === null) {
    store.db.prepare('UPDATE invite_codes SET revokedAt = ? WHERE id = ?').run(now.toISOString(), id);
    row.revokedAt = now.toISOString();
  }
  return row;
}

/** 这个账号是否已经用这个码核销过。用过就说明准入资格成立，不该因为码后来用完/吊销而被拒。 */
export function inviteCodeRedeemedBy(store: Store, code: string, handle: string): boolean {
  const row = store.db.prepare('SELECT id FROM invite_codes WHERE codeHash = ?').get(codeHash(code)) as { id: string } | undefined;
  if (!row) return false;
  return Boolean(store.db.prepare('SELECT 1 FROM invite_code_uses WHERE codeId = ? AND handle = ?').get(row.id, handle));
}

/** 邀请码当前是否还能用。不能用时返回原因，供报错文案区分。 */
export function inviteCodeProblem(store: Store, code: string, now: Date): 'not-found' | 'revoked' | 'expired' | 'exhausted' | null {
  const row = store.db.prepare('SELECT id, maxUses, usedCount, expiresAt, revokedAt FROM invite_codes WHERE codeHash = ?').get(codeHash(code));
  if (!row) return 'not-found';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && (row.expiresAt as string) <= now.toISOString()) return 'expired';
  if (row.maxUses !== null && Number(row.usedCount) >= Number(row.maxUses)) return 'exhausted';
  return null;
}

/**
 * 核销一次。同一账号对同一个码只算一次——重复填写不该把次数耗光。
 * 返回 false 表示这个账号之前已经用过这个码。
 */
export function redeemInviteCode(store: Store, code: string, handle: string, now: Date): boolean {
  // 不自己开事务：调用方（createAgentToken）已经在事务里，SQLite 不允许嵌套，
  // 而且核销必须和签发凭证同一个事务——签发失败时不能把次数扣掉。
  const row = store.db.prepare('SELECT id FROM invite_codes WHERE codeHash = ?').get(codeHash(code)) as { id: string } | undefined;
  if (!row) return false;
  const already = store.db.prepare('SELECT 1 FROM invite_code_uses WHERE codeId = ? AND handle = ?').get(row.id, handle);
  if (already) return false;
  store.db.prepare('INSERT INTO invite_code_uses (codeId, handle, usedAt) VALUES (?, ?, ?)').run(row.id, handle, now.toISOString());
  store.db.prepare('UPDATE invite_codes SET usedCount = usedCount + 1 WHERE id = ?').run(row.id);
  return true;
}

const PROBLEM_TEXT: Record<string, string> = {
  'not-found': '邀请码无效',
  revoked: '邀请码已被吊销',
  expired: '邀请码已过期',
  exhausted: '邀请码使用次数已用完',
};

export function inviteCodeError(problem: NonNullable<ReturnType<typeof inviteCodeProblem>>): ApiError {
  return new ApiError(403, 'ELIGIBILITY_REQUIRED', `${PROBLEM_TEXT[problem]}，请向发放者确认，或等待注册满 7 天、完成至少一篇审核通过的投稿`);
}

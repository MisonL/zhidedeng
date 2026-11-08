import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentToken, CreateAgentTokenRequest, CreateAgentTokenResponse, RevokeAgentTokenResponse } from '@zhidedeng/shared';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';

const MIN_ACCOUNT_AGE_MS = 7 * 86_400_000;
const MAX_ACTIVE_TOKENS = 5;

export const agentTokenSchema: z.ZodType<CreateAgentTokenRequest> = z.strictObject({
  label: z.string().trim().min(1).max(100),
  inviteCode: z.string().trim().min(1).max(200).optional(),
});

function requireEligibility(store: Store, handle: string, now: Date, inviteCode: string | undefined, inviteCodes: readonly string[]) {
  const account = store.db.prepare('SELECT createdAt, disabledAt FROM accounts WHERE handle = ?').get(handle);
  if (!account || account.disabledAt !== null) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
  const createdAt = typeof account.createdAt === 'string' ? Date.parse(account.createdAt) : NaN;
  if (now.getTime() - createdAt >= MIN_ACCOUNT_AGE_MS) return;
  // 普通站内投稿省略 source，读取时视为 user；作者字段是 authorHandle。
  const approved = store.db.prepare("SELECT 1 FROM entities WHERE kind = 'post' AND json_extract(data, '$.authorHandle') = ? AND json_extract(data, '$.status') = 'approved' AND COALESCE(json_extract(data, '$.source'), 'user') <> 'demo' LIMIT 1").get(handle);
  if (approved || (inviteCode !== undefined && inviteCodes.includes(inviteCode))) return;
  throw new ApiError(403, 'ELIGIBILITY_REQUIRED', '账号注册未满 7 天或缺少有效注册时间，且没有通过的非演示投稿；请等待注册满 7 天、完成至少一篇审核通过的投稿，或填写有效邀请码');
}

export function createAgentToken(store: Store, input: CreateAgentTokenRequest & {
  handle: string;
  now: Date;
  inviteCodes?: readonly string[];
}): CreateAgentTokenResponse {
  const issued = store.transaction(() => {
    requireEligibility(store, input.handle, input.now, input.inviteCode, input.inviteCodes ?? []);
    const active = Number(store.db.prepare('SELECT count(*) AS count FROM agent_tokens WHERE handle = ? AND revokedAt IS NULL').get(input.handle)!.count);
    if (active >= MAX_ACTIVE_TOKENS) throw new ApiError(409, 'TOKEN_LIMIT', '每个账号最多保留 5 个活跃凭证，请先吊销不再使用的凭证');
    const token = 'zd_' + randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    // 哈希无法还原展示前缀，只保存前八个字符，不保存完整明文。
    const record = { id: randomUUID(), tokenPrefix: token.slice(0, 8) + '\u2026', label: input.label, createdAt: input.now.toISOString() };
    store.db.prepare('INSERT INTO agent_tokens (id, handle, tokenHash, label, tokenPrefix, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, input.handle, tokenHash, record.label, record.tokenPrefix, record.createdAt);
    return { ...record, token };
  });
  // 成功提交后再审计，失败的事务不能留下成功日志；不记录标签、邀请码或密码学材料。
  console.info(JSON.stringify({ action: 'agent_token.issued', handle: input.handle, tokenId: issued.id, at: issued.createdAt }));
  return issued;
}

export function listAgentTokens(store: Store, handle: string): AgentToken[] {
  const rows = store.db.prepare('SELECT id, label, tokenPrefix, createdAt, lastUsedAt, revokedAt, useCount FROM agent_tokens WHERE handle = ? ORDER BY createdAt DESC, rowid DESC').all(handle);
  return rows.map(row => ({
    id: row.id as string, label: row.label as string, tokenPrefix: row.tokenPrefix as string,
    createdAt: row.createdAt as string, lastUsedAt: row.lastUsedAt as string | null,
    revokedAt: row.revokedAt as string | null, useCount: Number(row.useCount),
    status: row.revokedAt === null ? 'active' : 'revoked',
  }));
}

export function revokeAgentToken(store: Store, handle: string, id: string, now: Date): RevokeAgentTokenResponse {
  const result = store.transaction(() => {
    const row = store.db.prepare('SELECT revokedAt FROM agent_tokens WHERE id = ? AND handle = ?').get(id, handle);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '凭证不存在');
    if (row.revokedAt !== null) return { response: { id, revokedAt: row.revokedAt as string }, changed: false };
    const revokedAt = now.toISOString();
    store.db.prepare('UPDATE agent_tokens SET revokedAt = ? WHERE id = ? AND handle = ? AND revokedAt IS NULL').run(revokedAt, id, handle);
    return { response: { id, revokedAt }, changed: true };
  });
  if (result.changed) console.info(JSON.stringify({ action: 'agent_token.revoked', handle, tokenId: id, at: result.response.revokedAt }));
  return result.response;
}

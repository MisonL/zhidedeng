import { createHash } from 'node:crypto';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';

const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'Agent 凭证无效，请重新签发或检查 Authorization 头');

export function agentTokenHash(header: string | undefined): string {
  const token = header?.match(/^Bearer[ \t]+(\S+)$/i)?.[1];
  if (!token) throw unauthenticated();
  return createHash('sha256').update(token).digest('hex');
}

/** 只按唯一 tokenHash 查库；账号禁用和凭证吊销使用同一个拒绝响应。 */
export function activeAgentHandle(store: Store, tokenHash: string): string {
  const row = store.db.prepare(`SELECT agent_tokens.handle FROM agent_tokens
    JOIN accounts ON accounts.handle = agent_tokens.handle
    WHERE agent_tokens.tokenHash = ? AND agent_tokens.revokedAt IS NULL AND accounts.disabledAt IS NULL`).get(tokenHash);
  if (!row) throw unauthenticated();
  return row.handle as string;
}

export function agentHandle(store: Store, header: string | undefined, now: Date): string {
  const tokenHash = agentTokenHash(header);
  return store.transaction(() => {
    const handle = activeAgentHandle(store, tokenHash);
    store.db.prepare('UPDATE agent_tokens SET lastUsedAt = ?, useCount = useCount + 1 WHERE tokenHash = ?')
      .run(now.toISOString(), tokenHash);
    return handle;
  });
}

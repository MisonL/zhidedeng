/**
 * SKILL.md 与 CLI 实现的一致性检查。
 *
 * Skill 是写给 AI Agent 的指令文档。文档和实现漂移的后果比普通文档更严重：
 * Agent 会照着文档调用不存在的命令、以为某个字段能写、或者误解退出码含义，
 * 而且不会有任何报错——它只会「安静地做错事」。
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT } from '../zd.ts';

const repoRoot = join(process.cwd(), '..');
const skillPath = join(repoRoot, '.claude/skills/zd-submit/SKILL.md');

async function skill(): Promise<string> {
  return readFile(skillPath, 'utf8');
}

describe('SKILL.md 与 CLI 一致', () => {
  it('文档里提到的每个 zd 子命令都真实存在', async () => {
    const text = await skill();
    const mentioned = new Set([...text.matchAll(/zd ([a-z]+)/g)].map(match => match[1]));
    // 帮助里出现的命令清单以 zd.ts 的 run() 分支为准。
    const known = new Set(['login', 'whoami', 'catalog', 'match', 'validate', 'submit', 'status', 'help']);
    const unknown = [...mentioned].filter(command => !known.has(command!));
    expect(unknown).toEqual([]);
  });

  it('退出码数值与实现一致', async () => {
    const text = await skill();
    const rows: [string, number][] = [
      ['成功', EXIT.ok],
      ['用法错误', EXIT.usage],
      ['网络/服务端故障', EXIT.network],
      ['本地校验失败', EXIT.validation],
      ['服务端拒绝', EXIT.rejected],
      ['未登录/凭证无效', EXIT.unauthorized],
    ];
    for (const [label, code] of rows) {
      // 表格行形如 `| 3 | 本地校验失败 | ... |`
      const row = text.split('\n').find(line => line.includes(`| ${label} |`) && line.trim().startsWith('|'));
      expect(row, `退出码表缺少「${label}」这一行`).toBeDefined();
      expect(row!).toContain(`| ${code} |`);
    }
  });

  it('禁字段清单与实现一致', async () => {
    const text = await skill();
    // 与 shared/src/submission.ts 的 forbiddenAgentFields 对应。
    for (const field of ['uptime', 'firstTokenLatencyMs', 'foundedAt', 'status', 'score', 'lowestRate']) {
      expect(text).toContain(field);
    }
  });

  it('配额数字与服务端常量一致', async () => {
    const text = await skill();
    const agentApi = await readFile(join(repoRoot, 'server/src/agent-api.ts'), 'utf8');
    const read = (name: string): number => {
      const found = agentApi.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`));
      if (!found) throw new Error(`agent-api.ts 里没找到常量 ${name}`);
      return Number(found[1]!.replace(/_/g, ''));
    };
    const limits: [string, number][] = [
      ['TOKEN_PER_HOUR', read('TOKEN_PER_HOUR')],
      ['ACCOUNT_PER_HOUR', read('ACCOUNT_PER_HOUR')],
      ['IP_PER_HOUR', read('IP_PER_HOUR')],
      ['ACCOUNT_PENDING', read('ACCOUNT_PENDING')],
      ['HOSTNAME_PENDING', read('HOSTNAME_PENDING')],
    ];
    for (const [name, value] of limits) {
      expect(text, `配额的 ${name}（${value}）没有写进文档`).toContain(String(value));
    }
  });

  it('提到了 deduplicated 语义，避免 Agent 把幂等命中当失败', async () => {
    expect(await skill()).toContain('deduplicated');
  });

  it('明确写了「不要编造」，不只是列字段', async () => {
    const text = await skill();
    expect(text).toMatch(/不要编造|不要编造、不要推测/);
  });
});

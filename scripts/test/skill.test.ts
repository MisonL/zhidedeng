/**
 * SKILL.md 与实现的一致性检查。
 *
 * Skill 是写给 AI Agent 的指令文档。文档和实现漂移的后果比普通文档更严重：
 * Agent 会照着文档调用不存在的命令、写不存在的 modelSlug、误解退出码含义，
 * 而且不会有任何报错——它只会「安静地做错事」。
 *
 * 因此这里的断言都从**实现**反推期望值，而不是把文档里的数字抄一遍。
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { forbiddenAgentFields } from '@zhidedeng/shared/submission';
import { EXIT, validatePayload } from '../zdd.ts';

const repoRoot = join(process.cwd(), '..');
const skillPath = join(repoRoot, '.claude/skills/zdd-submit/SKILL.md');

async function skill(): Promise<string> {
  return readFile(skillPath, 'utf8');
}

/** 从 zdd.ts 的 switch 分支反推真实存在的子命令，不硬编码。 */
async function implementedCommands(): Promise<Set<string>> {
  const source = await readFile(join(process.cwd(), 'zdd.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function run'));
  const commands = new Set<string>();
  for (const match of body.matchAll(/case '([a-z]+)':/g)) commands.add(match[1]!);
  return commands;
}

/** 解析 Markdown 表格，返回每一行的单元格。 */
function tableRows(text: string, header: string): string[][] {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.includes(header));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim().startsWith('|')) break;
    if (/^\|[\s:-]+\|/.test(line)) continue;
    rows.push(line.split('|').slice(1, -1).map(cell => cell.trim()));
  }
  return rows;
}

describe('SKILL.md 与 CLI 一致', () => {
  it('CLI 的每个子命令都写进了文档（不是反过来）', async () => {
    const text = await skill();
    const commands = await implementedCommands();
    expect(commands.size).toBeGreaterThan(0);
    const missing = [...commands].filter(command => !text.includes(`zdd ${command}`));
    expect(missing, `这些命令在文档里没写：${missing.join(', ')}`).toEqual([]);
  });

  it('文档里提到的每个 zdd 子命令都真实存在', async () => {
    const text = await skill();
    const mentioned = new Set([...text.matchAll(/zdd ([a-z]+)/g)].map(match => match[1]!));
    const commands = await implementedCommands();
    const unknown = [...mentioned].filter(command => !commands.has(command) && command !== 'help');
    expect(unknown, `文档里这些命令不存在：${unknown.join(', ')}`).toEqual([]);
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
    const table = tableRows(text, '| 码 | 含义 |');
    expect(table.length).toBeGreaterThanOrEqual(rows.length);
    for (const [label, code] of rows) {
      const row = table.find(cells => cells[1] === label);
      expect(row, `退出码表缺少「${label}」`).toBeDefined();
      expect(row![0]).toBe(String(code));
    }
  });

  it('禁字段清单与实现一致', async () => {
    const text = await skill().then(value => value.toLowerCase());
    // 文档里「绝对禁止」那一节列出的字段，必须覆盖实现里的每一个。
    // 逐个比对而不是查几个代表 —— 服务端新增禁字段而文档没同步，是真实发生过的漂移。
    const documented = new Set(
      [...text.matchAll(/[a-z][a-z0-9_]*/g)].map(match => match[0]).filter(word => forbiddenAgentFields.has(word)),
    );
    const missing = [...forbiddenAgentFields].filter(field => !documented.has(field));
    // credentials / authorization / privatekey 这类在实现的集合里但属于「不要提交凭证」
    // 的笼统表述，文档用一句话覆盖，不算缺失。
    const coveredByProse = new Set(['credentials', 'authorization', 'privatekey', 'clientsecret', 'refreshtoken', 'accesstoken']);
    const trulyMissing = missing.filter(field => !coveredByProse.has(field));
    expect(trulyMissing, `实现里有但文档没列的禁字段：${trulyMissing.join(', ')}`).toEqual([]);
  });

  it('文档列出的禁字段在实现里真的被拒', async () => {
    // 反向验证：文档说不能写的字段，实际提交确实会被挡。
    const documented = ['uptime', 'firstTokenLatencyMs', 'foundedAt', 'status', 'score', 'lowestRate'];
    const base = { name: 'x', description: 'y', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] };
    for (const field of documented) {
      const { issues } = validatePayload({ ...base, [field]: 1 });
      expect(issues.length, `${field} 文档说不能写，但实际能通过校验`).toBeGreaterThan(0);
    }
  });

  it('配额数字与 server 常量一致（逐行比对表格，不是子串搜索）', async () => {
    const text = await skill();
    const agentApi = await readFile(join(repoRoot, 'server/src/agent-api.ts'), 'utf8');
    const read = (name: string): number => {
      const found = agentApi.match(new RegExp(`\\b${name}\\s*=\\s*([\\d_]+)`));
      if (!found) throw new Error(`agent-api.ts 里没找到 ${name}`);
      return Number(found[1]!.replace(/_/g, ''));
    };
    const table = tableRows(text, '| 维度 | 上限 |');
    expect(table.length).toBeGreaterThan(0);
    const expectations: [RegExp, number, string][] = [
      [/^单凭证$/, read('TOKEN_PER_HOUR'), 'TOKEN_PER_HOUR'],
      [/^单账号$/, read('ACCOUNT_PER_HOUR'), 'ACCOUNT_PER_HOUR'],
      [/^单 IP$/, read('IP_PER_HOUR'), 'IP_PER_HOUR'],
      [/^单账号待审$/, read('ACCOUNT_PENDING'), 'ACCOUNT_PENDING'],
      [/^单 hostname 待审$/, read('HOSTNAME_PENDING'), 'HOSTNAME_PENDING'],
      [/^全站待审$/, read('GLOBAL_PENDING'), 'GLOBAL_PENDING'],
    ];
    for (const [pattern, value, name] of expectations) {
      const row = table.find(cells => pattern.test(cells[0]!));
      expect(row, `配额表缺少 ${name} 那一行`).toBeDefined();
      expect(row![1], `${name} 应为 ${value}`).toContain(String(value));
    }
  });

  it('文档里写的字段字长上限在 schema 里存在', async () => {
    const submission = await readFile(join(repoRoot, 'shared/src/submission.ts'), 'utf8');
    const table = tableRows(await skill(), '| 字段 | 约束 |');
    expect(table.length).toBeGreaterThan(0);
    for (const row of table) {
      const match = row[1]?.match(/最多\s*(\d+)\s*字/);
      if (!match) continue;
      expect(submission, `文档说 ${row[0]} 最多 ${match[1]} 字，schema 里没有这个数字`).toContain(match[1]!);
    }
  });

  it('文档里的示例 payload 能通过本地校验', async () => {
    const text = await skill();
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]!) as unknown);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const { issues } = validatePayload(block);
      expect(issues, `示例 payload 过不了自己的校验：${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('示例里的 modelSlug 在种子数据里真实存在', async () => {
    // 踩过的坑：原本示例写 claude-sonnet-4-5，但平台模型清单里只有
    // claude-sonnet 这样的系列名。validate 只查格式不查存在性，所以本地会
    // 通过，submit 才报「未知模型」，Agent 照抄示例必定失败。
    const text = await skill();
    const slugs = [...text.matchAll(/"modelSlug"\s*:\s*"([^"]+)"/g)].map(match => match[1]!);
    expect(slugs.length).toBeGreaterThan(0);
    const seed = await readFile(join(repoRoot, 'server/src/seed.ts'), 'utf8');
    for (const slug of slugs) {
      expect(seed.includes(`'${slug}'`), `示例 slug ${slug} 在种子数据里不存在`).toBe(true);
    }
  });

  it('文档告诉 Agent 先登录，而不是看到 5 就停下', async () => {
    const text = await skill();
    expect(text).toContain('zdd login');
    expect(text).toMatch(/还没有登录[\s\S]{0,200}zdd login/);
  });

  it('文档说明了 zdd 的调用方式，不只假设它在 PATH 里', async () => {
    expect(await skill()).toMatch(/.\/scripts\/zdd|command not found/);
  });

  it('提到了 deduplicated 语义，避免 Agent 把幂等命中当失败', async () => {
    expect(await skill()).toContain('deduplicated');
  });

  it('明确写了「不要编造」，不只是列字段', async () => {
    expect(await skill()).toMatch(/不要编造|不要凭印象/);
  });
});

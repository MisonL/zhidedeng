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

  it('实现里的每个禁字段都真的被拒，且文档都提到了', async () => {
    // 从实现的集合动态取，不硬编码 —— 早先只验了六个指标字段，
    // 服务端新增凭证类禁字段而文档漏写时，测试不会报。
    const base = { name: 'x', description: 'y', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] };
    const text = (await skill()).toLowerCase();
    for (const field of forbiddenAgentFields) {
      const { issues } = validatePayload({ ...base, [field]: 1 });
      expect(issues.length, `禁字段 ${field} 实际能通过校验`).toBeGreaterThan(0);
      // 文档用各种大小写和分隔符写法列出它们，统一规范化后比较。
      const normalized = field.replace(/[_-]/g, '');
      const mentioned = [...text.matchAll(/[a-z][a-z0-9_-]*/g)]
        .some(match => match[0].replace(/[_-]/g, '') === normalized);
      expect(mentioned, `禁字段 ${field} 没写进文档`).toBe(true);
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
      const count = row![1]!.match(/^(\d+)\s*条(?:\/小时)?(?:[（(]|$)/);
      expect(count, `${name} 的数量格式不合法：${row![1]}`).not.toBeNull();
      expect(Number(count![1]), `${name} 应为 ${value}`).toBe(value);
    }
  });

  it('文档里每个字段的字长上限都与 schema 一致', async () => {
    // 从 schema 源码直接读 text(N) 的上限，再核对文档有没有写对。
    //
    // 早先只匹配「最多 N 字」，漏掉了 title / summary / body 写在同一行、
    // 用斜杠分隔 100 / 200 / 5000 的那种行 —— 把 body 改成 9999 测试也不会报。
    // 所以这里按字段名逐个找，找不到对应数字就算失败。
    const submission = await readFile(join(repoRoot, 'shared/src/submission.ts'), 'utf8');
    // 同一字段名可能在不同 schema 里有不同上限（站点的 description 300、模型 200）。
    // 早先用 Map 会让后者覆盖前者，模型那条上限就永远查不到。
    // 现在按「schema 块」分段，逐块收集，任何一块写错都会被抓到。
    const limits: { field: string; limit: number }[] = [];
    const blocks = submission.split(/\nexport const /);
    for (const block of blocks) {
      for (const match of block.matchAll(/\b([a-zA-Z]+):\s*text\((\d+)\)/g)) {
        if (forbiddenAgentFields.has(match[1]!.toLowerCase())) continue;
        // 同一个块内同名只记一次，跨块各自保留。
        const field = match[1]!;
        const limit = Number(match[2]);
        if (!limits.some(entry => entry.field === field && entry.limit === limit)) limits.push({ field, limit });
      }
    }
    expect(limits.length).toBeGreaterThan(5);

    const table = tableRows(await skill(), '| 字段 | 约束 |');
    // 文档里用「（模型）」这类后缀区分同名字段，比对时去掉限定语。
    const normalize = (cell: string) => cell.replace(/`/g, '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();
    const rowsFor = (field: string) => table.filter(cells => cells[0]!.split('/').some(name => normalize(name) === field));

    // 必须真正找到这一行。早先 `if (!row) continue` 会让删掉整行的变异静默通过。
    const missing = limits.filter(entry => rowsFor(entry.field).length === 0).map(entry => entry.field);
    expect(missing, `这些字段在约束表里没有独立一行：${missing.join(', ')}`).toEqual([]);

    for (const { field, limit } of limits) {
      // 同名字段有多个上限时，只要有一行写对这个上限即可。
      const candidates = rowsFor(field);
      const matched = candidates.some(cells => [...cells[1]!.matchAll(/\d+/g)].map(m => Number(m[0])).includes(limit));
      if (matched) continue;
      const cells = candidates[0]!;
      const names = cells[0]!.replace(/`/g, '').split('/').map(name => name.trim());
      const numbers = [...cells[1]!.matchAll(/\d+/g)].map(match => Number(match[0]));

      if (field === 'title' || field === 'summary' || field === 'body') {
        // 这三个挤在一行，用「斜杠分隔的字段名」和「斜杠分隔的数字」按位置对齐。
        const segments = cells[1]!.split('/').map(part => part.trim());
        expect(segments.length, `${field} 那一行的数字应和字段一一对应：${cells[1]}`).toBe(names.length);
        const index = names.indexOf(field);
        expect(Number(segments[index]!.match(/^\d+/)?.[0]), `文档里 ${field} 的上限写错了：${cells[1]}`).toBe(limit);
        continue;
      }

      // 单字段行：直接比对唯一的那个上限数字。
      expect(numbers, `文档里 ${field} 的上限应恰好是 ${limit}：${cells[1]}`).toEqual([limit]);
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

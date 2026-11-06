import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogImportRequest } from '@zhidedeng/shared';
import { buildImport, normalizeUrl, parseRecordPage } from '../sync-feishu.ts';
import type { RawRecord } from '../sync-feishu.ts';

const SCRIPT = resolve(import.meta.dirname, '../sync-feishu.ts');
const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const MODELS = [
  { slug: 'gpt-4-1', name: 'GPT-4.1' }, { slug: 'claude-sonnet', name: 'Claude Sonnet' }, { slug: 'o3', name: 'o3' },
  { slug: 'gemini-pro', name: 'Gemini Pro' }, { slug: 'deepseek-chat', name: 'DeepSeek Chat' }, { slug: 'glm', name: 'GLM' }, { slug: 'kimi', name: 'Kimi' },
];
const fixtureRecords = () => ['page-1', 'page-2'].flatMap(name => parseRecordPage(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).records);

describe('parseRecordPage', () => {
  it('解析带外层包装的列式返回', () => {
    const page = parseRecordPage(readFileSync(join(FIXTURES, 'page-1.json'), 'utf8'));
    expect(page.hasMore).toBe(true);
    expect(page.records).toHaveLength(4);
    expect(page.records[0]).toMatchObject({ recordId: 'recA1', fields: { 中转站名称: '示例站', 审核状态: ['通过'] } });
    expect(page.columns).toContain('审核状态');
  });

  it('也接受对象式记录和字段对象表头', () => {
    const items = parseRecordPage(JSON.stringify({ data: { items: [{ record_id: 'r1', fields: { 审核状态: '通过' } }], has_more: false } }));
    expect(items.records[0]).toEqual({ recordId: 'r1', fields: { 审核状态: '通过' } });
    const named = parseRecordPage(JSON.stringify({ data: { fields: [{ id: 'f1', name: '审核状态' }], record_id_list: ['r1'], data: [['通过']] } }));
    expect(named.records[0].fields).toEqual({ 审核状态: '通过' });
  });

  it('空表是合法结果', () => {
    expect(parseRecordPage(JSON.stringify({ data: { fields: [], record_id_list: [], data: [] } })).records).toEqual([]);
  });

  it.each([
    ['非 JSON', 'oops'],
    ['ok=false', JSON.stringify({ ok: false, error: { message: 'denied' } })],
    ['非 0 错误码', JSON.stringify({ code: 99991663, msg: 'denied' })],
    ['认不出的结构', JSON.stringify({ data: { something: [] } })],
    ['行数和记录 ID 对不上', JSON.stringify({ data: { fields: ['a'], record_id_list: ['r1', 'r2'], data: [['x']] } })],
  ])('%s 时抛错而不是当成空表（空表会清空站点）', (_name, raw) => {
    expect(() => parseRecordPage(raw)).toThrow();
  });
});

describe('normalizeUrl', () => {
  it('去掉 query、fragment 和账号信息，主机转小写', () => {
    expect(normalizeUrl('https://A.com/x/?aff=1#y')).toEqual({ url: 'https://a.com/x/', host: 'a.com' });
    expect(normalizeUrl('http://user:pw@a.com')).toEqual({ url: 'http://a.com/', host: 'a.com' });
    expect(normalizeUrl('https://www.a.com/')?.host).toBe('a.com');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://a.com/', 'a.com', 'localhost:3000/x', '', `https://a.com/${'x'.repeat(400)}`])('拒绝 %s', value => {
    expect(normalizeUrl(value)).toBeNull();
  });
});

describe('buildImport', () => {
  const result = () => buildImport(fixtureRecords(), MODELS);

  it('同站点取最新且非空的信息，query 和 fragment 被去掉', () => {
    const { payload } = result();
    expect(payload.stations.map(s => s.slug)).toEqual(['sub-api-example-com', 'sub-other-example']);
    expect(payload.stations[0]).toEqual({
      slug: 'sub-api-example-com', name: '示例站pro', url: 'https://api.example.com/',
      description: '更新了价格', rechargeThreshold: 20, paymentMethods: ['USDT'],
      offers: [{ modelSlug: 'gpt-4-1', rate: 0.4 }, { modelSlug: 'kimi', rate: 0.6 }],
    });
  });

  it('只同步严格等于「通过」的记录', () => {
    const text = JSON.stringify(result().payload);
    for (const name of ['pending', 'rejected', 'blank', 'space', 'multi']) expect(text).not.toContain(`${name}.example`);
    expect(text).not.toContain('待审内容');
  });

  it('审核备注绝不外传，日志也不带', () => {
    const { payload, skipped, notes } = result();
    expect(JSON.stringify({ payload, skipped, notes })).not.toContain('秘密');
  });

  it('评价各自成文章，展示昵称作为作者，空昵称用匿名，正文保持原文', () => {
    const { payload } = result();
    expect(payload.posts.map(p => p.recordId)).toEqual(['recA3', 'recA4']);
    expect(payload.posts[0]).toEqual({
      recordId: 'recA3', stationSlug: 'sub-api-example-com', title: '示例站pro · 使用评价',
      summary: '推荐指数 4/5 · <script>alert(1)</script> 不错 [点我](https://evil.example)',
      body: '<script>alert(1)</script> 不错\n[点我](https://evil.example)',
      authorName: '匿名群友', publishedAt: '2026-11-04T00:00:00.000Z',
    });
    expect(payload.posts[1]).toMatchObject({ title: '示例站pro · 避坑反馈', authorName: '群友乙', publishedAt: '2026-11-04T01:30:00.000Z', summary: '推荐指数 2/5 · 晚高峰经常超时' });
  });

  it('坏记录逐条跳过并说明原因', () => {
    const skipped = result().skipped.join('\n');
    expect(skipped).toMatch(/recC1.*网址/);
    expect(skipped).toMatch(/recC2.*名称/);
    expect(skipped).toMatch(/recC3.*网址/);
    expect(skipped).toMatch(/recC4.*提交时间/);
    expect(skipped).toMatch(/recC5.*提交类型/);
    expect(skipped).toMatch(/recC6.*网址/);
  });

  it('坏倍率行和未知模型只跳过那一行并报告', () => {
    const notes = result().notes.join('\n');
    for (const line of ['未知模型X', 'o3', 'gemini-pro', 'deepseek-chat', 'glm', 'kimi', '没有等号的行']) expect(notes).toContain(line);
    expect(notes).toMatch(/recA1/);
    expect(notes).toMatch(/recD1.*最低充值/);
    expect(notes).toMatch(/recD1.*推荐指数/);
  });

  it('没写报价的新记录不覆盖旧报价；更新记录带报价时整组替换', () => {
    const records: RawRecord[] = [
      { recordId: 'r1', fields: { 中转站名称: '站', 网址: 'https://a.com/', 提交类型: '推荐新站', 模型与倍率: 'o3=1\nGLM=2', 审核状态: '通过', 提交时间: '2026-01-01' } },
      { recordId: 'r2', fields: { 中转站名称: '站', 网址: 'https://a.com/', 提交类型: '避坑反馈', 使用体验: '坑', 审核状态: '通过', 提交时间: '2026-01-02' } },
    ];
    expect(buildImport(records, MODELS).payload.stations[0].offers).toEqual([{ modelSlug: 'glm', rate: 2 }, { modelSlug: 'o3', rate: 1 }]);
  });

  it('超长内容按上限截断', () => {
    const { payload } = buildImport([{ recordId: 'r1', fields: { 中转站名称: '名'.repeat(500), 网址: 'https://a.com/', 提交类型: '使用评价', 使用体验: '字'.repeat(9000), 展示昵称: '昵'.repeat(99), 审核状态: '通过', 提交时间: '2026-01-01' } }], MODELS);
    expect([...payload.stations[0].name]).toHaveLength(60);
    expect([...payload.posts[0].body]).toHaveLength(5000);
    expect([...payload.posts[0].authorName]).toHaveLength(30);
  });

  it('去掉控制字符和方向控制符，保留正文换行', () => {
    const { payload } = buildImport([{ recordId: 'r1', fields: { 中转站名称: '站\u202E名\u0000', 网址: 'https://a.com/', 提交类型: '使用评价', 使用体验: '第一行\r\n第\u200B二行\u0007', 审核状态: '通过', 提交时间: '2026-01-01' } }], MODELS);
    expect(payload.stations[0].name).toBe('站名');
    expect(payload.posts[0].body).toBe('第一行\n第二行');
  });

  it('结果与记录顺序无关，保证重复导入内容相同', () => {
    expect(buildImport(fixtureRecords().reverse(), MODELS).payload).toEqual(result().payload);
  });

  it('记录 ID 不合法时跳过', () => {
    const { payload, skipped } = buildImport([{ recordId: '../x', fields: { 中转站名称: '站', 网址: 'https://a.com/', 提交类型: '推荐新站', 审核状态: '通过', 提交时间: '2026-01-01' } }], MODELS);
    expect(payload.stations).toEqual([]);
    expect(skipped[0]).toContain('记录 ID');
  });
});

describe('命令行', () => {
  const BASE_TOKEN = 'base-token-SECRET';
  const SYNC_TOKEN = 'sync-token-SECRET';
  let dir: string;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let imports: { authorization: string | undefined; body: CatalogImportRequest }[];
  let importStatus: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sync-feishu-'));
    imports = [];
    importStatus = 200;
    // 假 lark-cli：把调用记下来，按 offset 返回 fixture。绝不接触飞书。
    writeFileSync(join(dir, 'lark-cli'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ args, configDir: process.env.LARKSUITE_CLI_CONFIG_DIR, home: process.env.HOME }) + '\\n');
if (process.env.FAKE_LARK_FAIL) { console.error('boom ' + args.join(' ')); process.exit(3); }
const offset = args[args.indexOf('--offset') + 1];
const fixture = process.env.FAKE_LARK_FIXTURE || (offset === '0' ? 'page-1' : 'page-2');
process.stdout.write(fs.readFileSync(${JSON.stringify(FIXTURES)} + '/' + fixture + '.json'));
`);
    chmodSync(join(dir, 'lark-cli'), 0o755);
    site = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url!.startsWith('/api/models')) {
          res.end(JSON.stringify({ items: MODELS, total: MODELS.length, page: 1, pageSize: 50 }));
        } else if (req.url === '/api/admin/import' && req.method === 'POST') {
          imports.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
          res.statusCode = importStatus;
          res.end(JSON.stringify({ changed: true, stations: 2, offers: 2, posts: 2 }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise(done => site.close(done));
    rmSync(dir, { recursive: true });
  });

  function run(args: string[], env: Record<string, string | undefined> = {}) {
    const merged = {
      PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME,
      LARKSUITE_CLI_CONFIG_DIR: join(dir, 'lark-config'), FEISHU_BASE_TOKEN: BASE_TOKEN, FEISHU_TABLE_ID: 'tblTest', SITE_URL: siteUrl, SYNC_TOKEN, ...env,
    };
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, ...args], { env: merged as NodeJS.ProcessEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise<{ code: number | null; output: string; stdout: string }>(done => child.on('close', code => done({ code, output: stdout + stderr, stdout })));
  }

  const larkCalls = () => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; configDir: string; home: string });
    } catch {
      return [];
    }
  };

  it('按页串行只读，配置目录走环境变量，不覆盖 HOME，然后带 token 发布', async () => {
    const { code, output } = await run([]);
    expect(output).toBe(output.replaceAll('SECRET', ''));
    expect(code).toBe(0);
    const calls = larkCalls();
    expect(calls.map(call => call.args)).toEqual([
      ['base', '+record-list', '--as', 'bot', '--base-token', BASE_TOKEN, '--table-id', 'tblTest', '--offset', '0', '--limit', '200'],
      ['base', '+record-list', '--as', 'bot', '--base-token', BASE_TOKEN, '--table-id', 'tblTest', '--offset', '4', '--limit', '200'],
    ]);
    for (const call of calls) {
      expect(call.configDir).toBe(join(dir, 'lark-config'));
      expect(call.home).toBe(process.env.HOME);
    }
    expect(imports).toHaveLength(1);
    expect(imports[0].authorization).toBe(`Bearer ${SYNC_TOKEN}`);
    expect(imports[0].body.stations.map(s => s.slug)).toEqual(['sub-api-example-com', 'sub-other-example']);
    expect(JSON.stringify(imports[0].body)).not.toContain('秘密');
  });

  it('--dry-run 打印内容和跳过原因，不发布，也不需要 SYNC_TOKEN', async () => {
    const { code, stdout } = await run(['--dry-run'], { SYNC_TOKEN: undefined });
    expect(code).toBe(0);
    expect(imports).toEqual([]);
    expect(stdout).toContain('示例站pro');
    expect(stdout).toMatch(/recC1.*网址/);
    expect(stdout).not.toContain('秘密');
  });

  it('缺少配置目录时直接退出，绝不回落到默认配置', async () => {
    const { code, output } = await run([], { LARKSUITE_CLI_CONFIG_DIR: undefined });
    expect(code).not.toBe(0);
    expect(output).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(larkCalls()).toEqual([]);
  });

  it('配置目录指向默认的 ~/.lark-cli 时拒绝', async () => {
    const { code, output } = await run([], { LARKSUITE_CLI_CONFIG_DIR: join(homedir(), '.lark-cli') });
    expect(code).not.toBe(0);
    expect(output).toContain('~/.lark-cli');
    expect(larkCalls()).toEqual([]);
  });

  it.each(['FEISHU_BASE_TOKEN', 'FEISHU_TABLE_ID', 'SITE_URL', 'SYNC_TOKEN'])('缺少 %s 时报错退出', async name => {
    const { code, output } = await run([], { [name]: undefined });
    expect(code).not.toBe(0);
    expect(output).toContain(name);
    expect(imports).toEqual([]);
  });

  it('非本机地址拒绝明文 http，避免 token 裸奔', async () => {
    const { code, output } = await run([], { SITE_URL: 'http://example.com' });
    expect(code).not.toBe(0);
    expect(output).toContain('https');
    expect(larkCalls()).toEqual([]);
  });

  it('读飞书失败时不发布，错误信息里也不带 token', async () => {
    const { code, output } = await run([], { FAKE_LARK_FAIL: '1' });
    expect(code).not.toBe(0);
    expect(imports).toEqual([]);
    expect(output).not.toContain(BASE_TOKEN);
    expect(output).not.toContain(SYNC_TOKEN);
  });

  it('表头缺少审核状态时不发布，防止改名后清空全站', async () => {
    writeFileSync(join(FIXTURES, '.tmp-renamed.json'), JSON.stringify({ data: { fields: ['中转站名称', '网址', '提交类型', '状态', '提交时间'], record_id_list: ['r1'], data: [['站', 'https://a.com', '推荐新站', '通过', '2026-01-01']], has_more: false } }));
    try {
      const { code, output } = await run([], { FAKE_LARK_FIXTURE: '.tmp-renamed' });
      expect(code).not.toBe(0);
      expect(output).toContain('审核状态');
      expect(imports).toEqual([]);
    } finally {
      rmSync(join(FIXTURES, '.tmp-renamed.json'));
    }
  });

  it('站点拒绝导入时退出码非 0，日志不带 token', async () => {
    importStatus = 403;
    const { code, output } = await run([]);
    expect(code).not.toBe(0);
    expect(output).toContain('403');
    expect(output).not.toContain(SYNC_TOKEN);
  });
});

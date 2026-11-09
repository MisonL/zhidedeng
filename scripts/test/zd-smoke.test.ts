/**
 * 冒烟测试：用真实 Node 进程和真实 server 跑一遍 CLI。
 *
 * 为什么需要它：单元测试用 vitest（esbuild 转译）跑，`zd.ts` 的语法能否被
 * `node --experimental-strip-types` 直接执行它测不到；CLI 对接口响应形状的
 * 假设，用自己编的 mock 也测不出来。这两类问题让 CLI 曾经完全无法启动、
 * catalog 恒返回空，而 100 多项单测全绿。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));
const zdPath = join(scriptsDir, 'zd.ts');
const port = 18991;
const base = `http://127.0.0.1:${port}`;

let server: ChildProcess | undefined;
let home: string;

/** 用真实 node 跑 CLI，返回退出码与 stdout/stderr。 */
async function zd(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--experimental-strip-types', zdPath, ...args], {
    cwd: scriptsDir,
    env: { ...process.env, ZD_API_BASE: base, ZD_CONFIG_HOME: home, NODE_ENV: '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number>(resolve => child.on('close', value => resolve(value ?? -1)));
  return { code, stdout, stderr };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'zd-smoke-'));
  server = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: '' },
    stdio: 'ignore',
  });
  // 等健康检查就绪，最多 20 秒。
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('server 没能在 20 秒内就绪');
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 300));
  server?.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
});

describe('真实进程冒烟', () => {
  it('用 node --experimental-strip-types 能启动并输出 help', async () => {
    const { code, stdout, stderr } = await zd(['help']);
    expect(code).toBe(0);
    expect(stderr).toContain('zd ——');
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
  });

  it('catalog 从真实接口读出非空目录', async () => {
    const { code, stdout } = await zd(['catalog']);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { vendors: unknown[]; models: unknown[]; stations: unknown[] };
    // 演示数据一定有厂商和模型；空数组说明解包形状又写错了。
    expect(result.vendors.length).toBeGreaterThan(0);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.stations.length).toBeGreaterThan(0);
  }, 30_000);

  it('match 能命中真实存在的模型', async () => {
    const { code, stdout } = await zd(['match', 'GPT-4.1']);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { matches: { slug: string }[] };
    expect(result.matches.map(model => model.slug)).toContain('gpt-4-1');
  }, 30_000);

  it('未登录时 whoami 以 5 退出', async () => {
    const { code, stdout } = await zd(['whoami'], { ZD_TOKEN: '' });
    expect(code).toBe(5);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 5 });
  });

  it('validate 对本地文件做校验，不联网', async () => {
    const path = join(home, 'bad.json');
    await (await import('node:fs/promises')).writeFile(path, JSON.stringify({ name: 'x', url: 'ftp://a.com/' }));
    const { code } = await zd(['validate', path]);
    expect(code).toBe(3);
  });

  it('未知命令不回显输入，避免误传的凭证被打到终端', async () => {
    const secret = 'zd_' + 'f'.repeat(40);
    const { code, stdout, stderr } = await zd([secret]);
    expect(code).toBe(1);
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  });
});

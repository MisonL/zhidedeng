/**
 * 守卫：前端产物里不能出现 zod。
 *
 * 背景：schemas 通过 @zhidedeng/shared/submission 子路径导出，zod 一旦
 * 进入浏览器包，产物会从 521,690 涨到 606,576 字节（+83KB）。web 不需要
 * 运行时校验，只 import 类型就够了。
 *
 * 这里直接跑一次 esbuild 打包，检查真实依赖图里有没有 zod。前几版用正则
 * 扫源码，先后被注释前缀、常量拼接、无空白 import、正则字符类里的双斜杠
 * 绕过，又误伤了 import 后带注释的 type 写法 —— 静态匹配永远堵不完。
 * 依赖图是构建器算出来的，没有绕过的可能。
 *
 * 打包在子进程里跑：esbuild 在 jsdom 环境会报 TextEncoder 断言失败，而
 * web 的 vitest 全局 setup 依赖 window，两者不能共存于同一进程。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const webRoot = process.cwd();
const checker = join(webRoot, 'test/bundle-check.mjs');

/** 打包并返回依赖图。contents 为空时打包真实入口 main.tsx。 */
function bundle(contents?: string): { inputs: string[]; bytes: number } {
  const args = [checker, webRoot];
  if (contents !== undefined) args.push(Buffer.from(contents, 'utf8').toString('base64'));
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as { inputs: string[]; bytes: number };
}

const zodFiles = (inputs: string[]) => inputs.filter(file => /[\\/]zod[\\/]/.test(file));

describe('前端产物不含 zod', () => {
  it('真实入口打包后的依赖图里没有 zod', () => {
    const { inputs } = bundle();
    expect(inputs.length).toBeGreaterThan(50);
    expect(zodFiles(inputs), `产物里混进了 zod：${zodFiles(inputs).slice(0, 5).join(', ')}`).toEqual([]);
  }, 180_000);

  it('守卫本身能发现真正把 zod 带进来的写法', () => {
    // 养一条能抓人的狗。这段故意运行时引入 schema，依赖图里必须有 zod；
    // 如果这里也报「没有 zod」，说明守卫失效了，上一条的绿灯毫无意义。
    const { inputs } = bundle(
      "import { stationSchema } from '@zhidedeng/shared/submission';\nexport const s = stationSchema;",
    );
    expect(zodFiles(inputs).length, '守卫失效：引入 schema 后依赖图里竟然没有 zod').toBeGreaterThan(0);
  }, 180_000);

  it('只引类型时不把 zod 带进产物', () => {
    // import type 编译期擦除，是 web 唯一该用的形式。
    const { inputs } = bundle(
      "import type { StationPayload } from '@zhidedeng/shared/submission';\nexport const s: StationPayload | null = null;",
    );
    expect(zodFiles(inputs)).toEqual([]);
  }, 180_000);

  it('常量拼接引入也能被发现', () => {
    // 纯正则扫源码时这条能绕过，依赖图不会。
    const { inputs } = bundle("const m = await import('@zhidedeng/' + 'shared/submission');\nexport const s = m;");
    expect(zodFiles(inputs).length).toBeGreaterThan(0);
  }, 180_000);
});

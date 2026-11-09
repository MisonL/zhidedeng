/**
 * 守卫：前端产物里不能混进 zod。
 *
 * 背景：schemas 通过 @zhidedeng/shared/submission 子路径导出，zod 一旦进了
 * 浏览器包，产物会从 521,690 涨到 606,576 字节（+83KB）。web 不需要运行时
 * 校验，只 import 类型就够了。
 *
 * 两道检查，缺一不可：
 *
 * 1. 依赖图检查 —— 跑 esbuild 打包，看真实依赖图里有没有 zod。构建器算出来
 *    的结果，注释、字符串、正则里的双斜杠都干扰不了它。这是主防线。
 *
 * 2. 非字面量动态 import 探针 —— esbuild 的静态图看不见 import(变量)，
 *    这类代码在它眼里只是一次运行时调用。实测 Vite 会把 submission 单独
 *    打成 85KB 的 chunk 混进产物，而 esbuild 的图里 inputs=1、看不到 zod。
 *    所以额外禁止一切非字面量的动态 import：这是条明确规则，也堵住了
 *    静态分析的天生盲区。
 *
 * 打包放在子进程里跑：esbuild 在 jsdom 环境会报 TextEncoder 断言失败，
 * 而 web 的 vitest 全局 setup 依赖 window，两者不能共存于同一进程。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const webRoot = process.cwd();
const checker = join(webRoot, 'test/bundle-check.mjs');
const submissionModule = '@zhidedeng/shared/submission';

/** 打包并返回依赖图。contents 为空时打包真实入口 main.tsx。 */
function bundle(contents?: string): { inputs: string[]; bytes: number } {
  const args = [checker, webRoot];
  if (contents !== undefined) args.push(Buffer.from(contents, 'utf8').toString('base64'));
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as { inputs: string[]; bytes: number };
}

const zodFiles = (inputs: string[]) => inputs.filter(file => /[\\/]zod[\\/]/.test(file));

/** 抹掉注释，避免把注释里的示例当成真的代码。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/**
 * 找出所有「动态 import 但实参不是一个完整字面量」的位置。
 *
 * 关键是要找到整个实参、而不是只看括号后第一个字符：
 * `import('@zhidedeng/shared/' + 'submission')` 的第一个字符是引号，
 * 只查首字符会放行，而 Vite 能把这种拼接静态求值、真的打出 zod chunk。
 * 所以字面量结束之后必须紧跟 `)`，出现 `+` 就算拼接。
 *
 * 模板字符串里带 `\${}` 同样算违规：Vite 解析不了，会退化成运行时拼接。
 */
export function findNonLiteralImports(source: string): number[] {
  const clean = stripComments(source);
  const hits: number[] = [];
  const re = /\bimport\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    let index = match.index + match[0].length;
    while (index < clean.length && /\s/.test(clean[index]!)) index++;
    const quote = clean[index];
    let end = -1;
    if (quote === "'" || quote === '"') {
      let cursor = index + 1;
      while (cursor < clean.length && clean[cursor] !== quote) cursor += clean[cursor] === '\\' ? 2 : 1;
      if (clean[cursor] === quote) end = cursor + 1;
    } else if (quote === '`') {
      let cursor = index + 1;
      while (cursor < clean.length && clean[cursor] !== '`') cursor += clean[cursor] === '\\' ? 2 : 1;
      if (clean[cursor] === '`' && !clean.slice(index + 1, cursor).includes('${')) end = cursor + 1;
    }
    if (end < 0) {
      hits.push(match.index);
      continue;
    }
    let next = end;
    while (next < clean.length && /\s/.test(clean[next]!)) next++;
    if (clean[next] !== ')') hits.push(match.index);
  }
  return hits;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

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
      `import { stationSchema } from '${submissionModule}';\nexport const s = stationSchema;`,
    );
    expect(zodFiles(inputs).length, '守卫失效：引入 schema 后依赖图里竟然没有 zod').toBeGreaterThan(0);
  }, 180_000);

  it('只引类型时不把 zod 带进产物', () => {
    const { inputs } = bundle(
      `import type { StationPayload } from '${submissionModule}';\nexport const s: StationPayload | null = null;`,
    );
    expect(zodFiles(inputs)).toEqual([]);
  }, 180_000);

  it('源码里没有非字面量的动态 import', async () => {
    // esbuild 的静态图看不见 import(变量)，这类写法整片是盲区。
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(webRoot, 'src'))) {
      if (findNonLiteralImports(await readFile(file, 'utf8')).length > 0) {
        offenders.push(file.replace(join(webRoot, 'src') + '/', 'src/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('探针能分辨字面量实参和各种绕法', () => {
    // 放行：实参是单一完整字面量
    expect(findNonLiteralImports("const m = await import('x')")).toHaveLength(0);
    expect(findNonLiteralImports('const m = await import(`x`)')).toHaveLength(0);
    expect(findNonLiteralImports("const m = await import( 'x' )")).toHaveLength(0);
    expect(findNonLiteralImports(`const m = await import(\n  'x'\n)`)).toHaveLength(0);

    // 拦下：拼接。Vite 能把纯字面量拼接静态求值，真的会打进产物
    expect(findNonLiteralImports(`import('prefix' + name)`)).toHaveLength(1);
    expect(findNonLiteralImports(`import(name + 'suffix')`)).toHaveLength(1);
    expect(findNonLiteralImports(`import('a' + 'b')`)).toHaveLength(1);

    // 拦下：变量、模板插值、函数调用
    expect(findNonLiteralImports('import(p)')).toHaveLength(1);
    expect(findNonLiteralImports('import(`./${name}`)')).toHaveLength(1);
    expect(findNonLiteralImports(`import(getPath())`)).toHaveLength(1);

    // 注释里的不算
    expect(findNonLiteralImports('// import(p)')).toHaveLength(0);
    expect(findNonLiteralImports("/* import('a' + b) */")).toHaveLength(0);
  });

  it('没有源码直接引入 zod', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(webRoot, 'src'))) {
      if (/from\s+['"]zod['"]/.test(await readFile(file, 'utf8'))) {
        offenders.push(file.replace(join(webRoot, 'src') + '/', 'src/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});

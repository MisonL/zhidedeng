/**
 * 守卫：前端源码不能运行时引入会带进 zod 的模块。
 *
 * 背景：schemas 通过 `@zhidedeng/shared/submission` 子路径导出，因为 zod 一旦
 * 进入浏览器包会让产物从 521,690 涨到 606,576 字节（+83KB）。web 其实不需要
 * 运行时校验，只 import 类型就够了。这里用静态扫描代替构建产物体积检查——
 * 快得多，也能指出是哪个文件引入的。
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// jsdom 环境下 import.meta.url 不是 file: 协议，用 cwd 拼路径（vitest 在 web/ 下运行）。
const webSrc = join(process.cwd(), 'src') + '/';
const SUBMISSION_MODULE = '@zhidedeng/shared/submission';

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

/** 抹掉注释，避免把注释掉的 import 当成违规。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // 行注释：避开 http:// 这类协议前缀
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/**
 * 是否在运行时引用了 submission 模块。
 *
 * 不锚定行首：`/* x *\/ import {...}` 这种写法在锚定版本里能绕过。
 * 放行 `import type` / `export type`（编译期擦除），其余形态一律算违规。
 * 动态 import 用模板字符串不带插值的写法同样拦下。
 */
export function hasRuntimeImport(fullSource: string): boolean {
  const source = stripComments(fullSource);
  const escaped = SUBMISSION_MODULE.replace(/\//g, '\\/');
  // 动态 import()，含模板字符串写法
  if (new RegExp(`\\bimport\\s*\\(\\s*[\`'"]${escaped}[\`'"]`).test(source)) return true;
  // 静态 import / export ... from，排除 type 声明
  const staticRe = new RegExp(`\\b(import|export)\\s+(?!type\\b)[^;]*?\\bfrom\\s*['"]${escaped}['"]`);
  return staticRe.test(source);
}

describe('前端不引入运行时 schema', () => {
  it('没有任何源码从 @zhidedeng/shared/submission 做运行时导入', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(webSrc)) {
      if (hasRuntimeImport(await readFile(file, 'utf8'))) offenders.push(file.replace(webSrc, 'src/'));
    }
    expect(offenders).toEqual([]);
  });

  it('检测逻辑本身能分辨运行时引用和类型引用', () => {
    const target = SUBMISSION_MODULE;
    // 应判为违规：这些都会把 zod 带进产物
    expect(hasRuntimeImport(`import { a } from '${target}'`)).toBe(true);
    expect(hasRuntimeImport(`import {a} from '${target}'`)).toBe(true);
    expect(hasRuntimeImport(`/* header */ import { a } from '${target}'`)).toBe(true);
    expect(hasRuntimeImport(`\n// 说明\nimport { a } from '${target}'`)).toBe(true);
    expect(hasRuntimeImport(`export { a } from '${target}'`)).toBe(true);
    expect(hasRuntimeImport(`export * from '${target}'`)).toBe(true);
    expect(hasRuntimeImport(`const m = await import('${target}')`)).toBe(true);
    expect(hasRuntimeImport('const m = await import(`' + target + '`)')).toBe(true);
    expect(hasRuntimeImport(`import x from '${target}'; import y from 'z'`)).toBe(true);

    // 应放行：类型引用编译期被擦除，不进产物
    expect(hasRuntimeImport(`import type { A } from '${target}'`)).toBe(false);
    expect(hasRuntimeImport(`export type { A } from '${target}'`)).toBe(false);
    expect(hasRuntimeImport(`import type {A} from '${target}'`)).toBe(false);
    // 注释里的例子不算
    expect(hasRuntimeImport(`// 不要写 import { a } from '${target}'`)).toBe(false);
    expect(hasRuntimeImport(`/* import { a } from '${target}' */`)).toBe(false);
    // 别的模块不受影响
    expect(hasRuntimeImport(`import { API_ROUTES } from '@zhidedeng/shared'`)).toBe(false);
  });

  it('没有源码直接引入 zod', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(webSrc)) {
      const source = await readFile(file, 'utf8');
      if (/from\s+['"]zod['"]/.test(source)) offenders.push(file.replace(webSrc, 'src/'));
    }
    expect(offenders).toEqual([]);
  });
});

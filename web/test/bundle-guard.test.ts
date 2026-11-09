/**
 * 守卫：前端源码不能运行时引入会带进 zod 的模块。
 *
 * 背景：schemas 通过 `@zhidedeng/shared/submission` 子路径导出，因为 zod 一旦
 * 进入浏览器包会让产物从 521,690 涨到 606,576 字节（+83KB）。web 其实不需要
 * 运行时校验，只 import 类型就够了。这里用静态扫描代替构建产物体积检查——
 * 快得多，也能指出是哪一行引入的。
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// jsdom 环境下 import.meta.url 不是 file: 协议，用 cwd 拼路径（vitest 在 web/ 下运行）。
const webSrc = join(process.cwd(), 'src') + '/';

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

describe('前端不引入运行时 schema', () => {
  it('没有任何源码从 @zhidedeng/shared/submission 做非类型导入', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(webSrc)) {
      const source = await readFile(file, 'utf8');
      // `import type { ... } from '.../submission'` 会被编译期擦除，允许；
      // 不带 type 的 import 会把 zod 打进包里。
      const pattern = /import\s+(?!type\s)[^;]*from\s+['"]@zhidedeng\/shared\/submission['"]/g;
      if (pattern.test(source)) offenders.push(file.replace(webSrc, 'src/'));
    }
    expect(offenders).toEqual([]);
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

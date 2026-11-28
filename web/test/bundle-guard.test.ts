/**
 * 守卫：前端产物里不能出现 zod。
 *
 * 背景：schemas 通过 @zhidedeng/shared/submission 子路径导出，zod 一旦
 * 进了浏览器包，产物会从 521,690 涨到 606,000 字节以上。web 不需要运行时
 * 校验，只 import 类型就够了。
 *
 * 这里跑一次真实的 Vite 构建，直接检查产物。此前试过六版源码静态扫描，
 * 每一版都被实测打回：
 *
 * - 注释前缀、常量拼接、无空白 import、正则字符类里的双斜杠
 * - import(变量)、import('前缀' + 变量)、模板插值
 * - 字符串里的 // 让剥注释的正则吞掉同一行真实的导入
 *
 * 静态匹配要同时处理注释、字符串、正则、模板、运算符优先级，写对一次
 * 比写错七次难。构建产物没有这个问题——它就是要防的东西本身。
 *
 * 构建在临时目录里跑，不碰仓库的 src 和 dist。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = process.cwd();
const checker = join(webRoot, 'test/bundle-check.mjs');

interface BundleResult {
  ok: boolean;
  files: number;
  bytes: number;
  markers: number;
  /** 构建后 index.html 的 description，用来验证它就是 SITE_NOTICE。 */
  description?: string | null;
  error?: string;
}

/** 构建并返回产物信息。inject 会被追加到 main.tsx 末尾，用来验证检查器本身。 */
function build(inject?: string): BundleResult {
  const args = [checker, webRoot];
  if (inject !== undefined) args.push(Buffer.from(inject, 'utf8').toString('base64'));
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as BundleResult;
}

describe('前端产物不含 zod', () => {
  it('真实构建的产物里没有 zod', () => {
    const result = build();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.files).toBeGreaterThan(0);
    // 基线是 521,690 字节；批次 1（举报/头像选择器）涨约 5K，批次 2（对比页、
    // 作者主页、一句话反馈）再涨约 6K；批次 4（Token 商店/通知/文章编辑/
    // 审核台新增处置动作与「/docs 补全接口清单」）再涨约 4K，实测 595,364。
    // 所以这里是 600K：既留足真实新功能的余量，又不会放过 zod（带它的产物是
    // 606,000+，且 markers 一栏会直接命中）。
    //
    // 阈值只该在「合理新增了功能」时上调，并且要写明理由；拿它迁就一段突然
    // 涨大的代码等于把这道闸门关掉。
    //
    // 真正的判据是上面两条（构建通过 + 没有 zod 标识），这条只是粗线。
    expect(result.bytes).toBeLessThan(600_000);
    expect(result.markers, '产物里出现了 zod 的内部标识').toBe(0);
  }, 300_000);

  it('构建产物里的 description 就是 SITE_NOTICE，不是另一份手抄的文案', () => {
    // 这句话原来在 index.html 和 format.ts 各写一遍，改一处漏一处，
    // 出现过「页脚说三种来源、meta 只说两种」。现在源码里只有一份，
    // 这里锁住「注入确实发生了」——占位符没被替换时产物里会留着 %SITE_NOTICE%。
    const result = build();
    expect(result.description).toBeTruthy();
    expect(result.description).not.toContain('%SITE_NOTICE%');
    const source = readFileSync(join(webRoot, 'src/format.ts'), 'utf8');
    const notice = /export const SITE_NOTICE = '([^']+)'/.exec(source)?.[1];
    expect(result.description).toBe(notice);
  }, 300_000);

  it('robots.txt 在清演示数据之前是全站禁止，而不是放开抓取', () => {
    // 计划文档三处都写「robots.txt 保持 Disallow: /」，实际文件一度是
    // Allow: /——文档和代码各说一套。虚构内容被索引后不可撤回，这条必须钉死。
    const robots = readFileSync(join(webRoot, 'public/robots.txt'), 'utf8');
    const directives = robots.split('\n').filter(line => /^\s*(Allow|Disallow):/.test(line)).map(line => line.trim());
    expect(directives).toContain('Disallow: /');
    // 不能同时出现 Allow: /（后者会把全站放行，等于白写）。
    expect(directives).not.toContain('Allow: /');
  });

  it('检查器本身能发现真正把 zod 带进产物的写法', () => {
    // 养一条能抓人的狗。这段是审查实测能绕过静态扫描的写法：
    // 字符串里的 // 曾让剥注释的正则吞掉同一行真实的导入。
    // 如果构建也报「没有 zod」，说明检查器失效了，上一条的绿灯毫无意义。
    const result = build(
      `const text2 = '//';\nexport const result2 = import('@zhidedeng/shared/' + 'submission');`,
    );
    expect(result.error).toBeUndefined();
    expect(result.markers, '检查器失效：注入 schema 后产物里竟然没有 zod').toBeGreaterThan(0);
  }, 300_000);

  it('只引类型时不把 zod 带进产物', () => {
    const result = build(
      `import type { StationPayload } from '@zhidedeng/shared/submission';\nexport const typed: StationPayload | null = null;`,
    );
    expect(result.error).toBeUndefined();
    expect(result.markers).toBe(0);
  }, 300_000);
});

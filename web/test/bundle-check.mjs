/**
 * 在临时目录里跑一次真实 Vite 构建，检查产物里有没有 zod。
 *
 * 不碰仓库里的 src 和 dist：整个 web 复制到临时目录再构建。
 * 参数 base64 传入要注入 main.tsx 的代码，用来验证检查器本身有效。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const webRoot = process.argv[2];
const inject = process.argv[3] ? Buffer.from(process.argv[3], 'base64').toString('utf8') : null;
const work = mkdtempSync(join(tmpdir(), 'zd-webcheck-'));

try {
  for (const entry of readdirSync(webRoot)) {
    if (['src', 'public', 'index.html', 'vite.config.ts', 'package.json'].includes(entry)) {
      cpSync(join(webRoot, entry), join(work, entry), { recursive: true });
    }
  }
  symlinkSync(join(webRoot, 'node_modules'), join(work, 'node_modules'));
  if (inject) writeFileSync(join(work, 'src/main.tsx'), `\n${inject}\n`, { flag: 'a' });

  // 用仓库里的 vite 可执行文件，不走 `npx`：
  // npx 在 PATH 里找不到二进制时会**去 registry 下载一个**（曾经装到 vite 8.4，
  // 与项目锁定的版本不同，报错还指向无关的 plugin-react 解析失败）。
  // 临时目录里的 node_modules 是软链，npx 不一定跟进；直接给出绝对路径最稳。
  const viteBin = join(webRoot, 'node_modules', '.bin', 'vite');
  if (!existsSync(viteBin)) throw new Error(`找不到 ${viteBin}，先跑 pnpm install`);
  execFileSync(viteBin, ['build'], { cwd: work, stdio: 'pipe', env: { ...process.env, NODE_ENV: '' } });

  const assets = join(work, 'dist/assets');
  const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
  let bytes = 0;
  let markers = 0;
  for (const file of js) {
    const full = join(assets, file);
    bytes += statSync(full).size;
    const text = readFileSync(full, 'utf8');
    // 用 zod 内部独有的标识，避免匹配到正常代码里的常见词
    markers += (text.match(/ZodError|_zod|invalid_type|unrecognized_keys|invalid_union/g) ?? []).length;
  }
  // 顺手把 index.html 里注入后的 description 带出来：它是 SITE_NOTICE 常量的
  // 唯一副本，靠「页脚和 meta 说同一件事」这件事本身是有测试兜底的。
  const html = readFileSync(join(work, 'dist/index.html'), 'utf8');
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? null;
  process.stdout.write(JSON.stringify({ ok: true, files: js.length, bytes, markers, description }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error).slice(0, 500) }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

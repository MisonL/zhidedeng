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

  execFileSync("npx", ["vite", "build"], { cwd: work, stdio: 'pipe', env: { ...process.env, NODE_ENV: '' } });

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
  process.stdout.write(JSON.stringify({ ok: true, files: js.length, bytes, markers }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error).slice(0, 500) }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

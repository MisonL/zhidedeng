/**
 * 打包真实入口，输出依赖图里的文件列表。给 bundle-guard.test.ts 用。
 *
 * 单独放在 .mjs 里用子进程跑，是因为 esbuild 在 jsdom 环境下会报
 * TextEncoder 断言失败，而 web 的 vitest 全局 setup 又依赖 window。
 * 用子进程把「纯 node 的打包」和「需要 DOM 的测试环境」隔开。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const webRoot = process.argv[2];
const stdin = process.argv[3];
const require = createRequire(join(webRoot, 'package.json'));
const esbuild = require('esbuild');

const result = await esbuild.build({
  ...(stdin
    ? { stdin: { contents: Buffer.from(stdin, 'base64').toString('utf8'), resolveDir: join(webRoot, 'src'), loader: 'ts' } }
    : { entryPoints: [join(webRoot, 'src/main.tsx')] }),
  bundle: true,
  write: false,
  metafile: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.svg': 'dataurl', '.css': 'empty' },
  logLevel: 'silent',
});

process.stdout.write(JSON.stringify({
  inputs: Object.keys(result.metafile.inputs),
  bytes: Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0),
}));

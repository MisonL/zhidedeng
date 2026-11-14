import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('starts the native HTTP entry with PORT and DB_PATH overrides, serves writes, and shuts down', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (address === null || typeof address === 'string') throw new Error('未获得测试端口');
  const port = address.port;
  await new Promise<void>(done => reservation.close(() => done()));
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/index.ts')], {
    env: { ...process.env, PORT: String(port), DB_PATH: ':memory:' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', data => { output += String(data); });
  try {
    await new Promise<void>((ready, reject) => {
      // 该计时器限制服务就绪等待；外层用例也设为 30 秒，提前退出仍会立即报错。
      const timeout = setTimeout(() => reject(new Error(`启动超时：${output}`)), 30_000);
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`服务提前退出 ${code}：${output}`)); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', data => {
        output += String(data);
        if (output.includes('API listening')) { clearTimeout(timeout); ready(); }
      });
    });
    const base = `http://127.0.0.1:${port}/api`;
    const vendors = await fetch(`${base}/vendors`);
    expect(vendors.status).toBe(200);
    expect(await vendors.json()).toMatchObject({ total: 11 });
    const json = { 'content-type': 'application/json' };
    const registered = await fetch(`${base}/auth/register`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'http_tester', password: 'correct-horse-battery' }) });
    expect(registered.status).toBe(200);
    const headers = { ...json, cookie: registered.headers.get('set-cookie')!.split(';')[0] };
    const post = await fetch(`${base}/posts`, { method: 'POST', headers, body: JSON.stringify({ kind: 'guide', title: 'HTTP 关键流程', summary: '虚构站试用', body: '# 原样保留\n\n测试' }) });
    expect(post.status).toBe(200);
    const created = await post.json() as { id: string };
    expect(await (await fetch(`${base}/posts/${created.id}`, { headers })).json()).toMatchObject({ body: '# 原样保留\n\n测试', author: { handle: 'http_tester' } });
    expect((await fetch(`${base}/me/checkin`, { method: 'POST', headers })).status).toBe(200);
    expect((await fetch(`${base}/me/checkin`, { method: 'POST', headers })).status).toBe(409);
  } finally {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
  }
  expect(child.exitCode).toBe(0);
}, 30_000);

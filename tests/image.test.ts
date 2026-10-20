import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the image process serves health and build hooks, rejecting unsupported routes and methods', { timeout: 10_000 }, async () => {
  const server = spawn(process.execPath, [fileURLToPath(new URL('../image/server.mjs', import.meta.url))], {
    env: { PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(server, 'exit');
  const lines = createInterface({ input: server.stdout });
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(5_000) });
    const { event, port } = JSON.parse(line);
    assert.equal(event, 'listening');
    const endpoint = `http://127.0.0.1:${port}`;
    for (const [path, method, status] of [
      ['/health', 'GET', 200],
      ['/health?probe=1', 'GET', 200],
      ['/aws/lambda-microvms/runtime/v1/ready', 'GET', 200],
      ['/aws/lambda-microvms/runtime/v1/ready', 'POST', 200],
      ['/aws/lambda-microvms/runtime/v1/validate', 'POST', 200],
      ['/exec', 'POST', 404],
      ['/health', 'POST', 405],
      ['/aws/lambda-microvms/runtime/v1/ready', 'DELETE', 405],
    ] as const) {
      const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, status, `${method} ${path}`);
      assert.deepEqual(await response.json(), { status: status === 200 ? 'ok' : 'error' });
    }
  } finally {
    lines.close();
    server.kill('SIGTERM');
    await exited;
  }
});

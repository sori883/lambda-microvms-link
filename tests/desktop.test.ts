import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const module = fileURLToPath(new URL('../src/desktop.ts', import.meta.url));
const generation = '01234567-89ab-4cde-8012-3456789abcde';

async function fixture(options: { ensure?: string; connect?: string; open?: boolean; compiled?: boolean } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'mvm-desktop-test-'));
  const eventsPath = join(work, 'events.jsonl');
  await writeFile(eventsPath, '');
  const ssh = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
const log = (type, extra = {}) => appendFileSync(process.env.TEST_EVENTS, JSON.stringify({type, pid:process.pid, ...extra})+'\\n');
const command = process.argv.at(-1);
if(command === "'/usr/local/bin/mvm-desktop' 'ensure'") {
  log('ensure');
  if(process.env.TEST_ENSURE === 'missing') process.exit(127);
  if(process.env.TEST_ENSURE === 'invalid') { console.log('private-error-not-for-user'); process.exit(0); }
  if(process.env.TEST_ENSURE === 'oversized') { console.log('x'.repeat(20000)); process.exit(0); }
  if(process.env.TEST_ENSURE === 'failed-safe') { console.error('private-error-not-for-user\\nDesktopStartFailed:xvnc'); process.exit(1); }
  if(process.env.TEST_ENSURE === 'failed-unknown') { console.error('DesktopStartFailed:private-error-not-for-user'); process.exit(1); }
  if(process.env.TEST_ENSURE === 'hang') {
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});
    log('descendant',{childPid:child.pid});
    setInterval(()=>{},1000);
  } else console.log(JSON.stringify({protocol:1,generation:${JSON.stringify(generation)},width:1280,height:800}));
} else if(command === "'/usr/local/bin/mvm-desktop' 'connect' '${generation}'") {
  log('connect');
  process.on('SIGTERM',()=>{});
  process.stdout.write('RFB 003.008\\n');
  if(process.env.TEST_CONNECT === 'stall-input') {
    setInterval(()=>{},1000);
  } else if(process.env.TEST_CONNECT === 'flood') {
    const block=Buffer.alloc(65536,7);
    for(let i=0;i<16384;i++) if(!process.stdout.write(block)) await once(process.stdout,'drain');
    log('producer-finished');
  } else {
    process.stdin.on('data',chunk=>{log('input',{bytes:chunk.length});if(!process.stdout.write(chunk))process.stdin.pause();});
    process.stdout.on('drain',()=>process.stdin.resume());
    process.stdin.on('end',()=>process.exit(0));
  }
} else { log('unexpected',{command}); process.exit(9); }
`;
  await writeFile(join(work, 'ssh'), ssh, { mode: 0o700 });
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(work, name), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.TEST_EVENTS,JSON.stringify({type:'opener',pid:process.pid})+'\\n');
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`, { mode: 0o700 });
  }
  const script = join(work, 'run.ts');
  const connection = {
    id: generation, generation, alias: 'mvm-test', config: join(work, 'ssh-config'),
    directory: work, publicKey: '', vscodeDirectory: work,
  };
  await writeFile(script, `
import { sessionDesktop } from ${JSON.stringify(module)};
import { appendFileSync } from 'node:fs';
const controller = new AbortController();
process.once('SIGTERM',()=>controller.abort());
process.once('SIGINT',()=>controller.abort());
process.on('SIGUSR1',()=>console.log('MEMORY:'+process.memoryUsage().rss));
try {
  const code = await sessionDesktop(${JSON.stringify(connection)},${JSON.stringify({ open: options.open ?? false, port: 0 })},
    controller.signal,()=>appendFileSync(process.env.TEST_EVENTS,JSON.stringify({type:'prepared'})+'\\n'));
  process.exit(code);
} catch(error) { console.error(error.code+': '+error.message); process.exit(1); }
`);
  let executable = process.execPath;
  let args = [script];
  if (options.compiled) {
    const built = join(work, 'compiled');
    const result = await Bun.build({ entrypoints: [script], compile: { outfile: built } });
    assert.equal(result.success, true, result.logs.map(log => log.message).join('\n'));
    await mkdir(join(work, 'elsewhere'));
    executable = join(work, 'elsewhere', 'standalone');
    await copyFile(built, executable);
    args = [];
    await rm(script);
    await rm(built);
  }
  const child = spawn(executable, args, {
    cwd: options.compiled ? join(work, 'elsewhere') : work,
    env: {
      ...process.env, PATH: `${work}:${process.env.PATH}`, TEST_EVENTS: eventsPath,
      TEST_ENSURE: options.ensure, TEST_CONNECT: options.connect,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  let readyResolve!: (url: URL) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<URL>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const match = /^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/m.exec(stdout);
    if (match) readyResolve(new URL(match[0]));
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise<number | null>(resolve => {
    child.once('close', code => { readyReject(new Error(stderr || 'Desktop exited before readiness.')); resolve(code); });
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
  void done.then(() => clearTimeout(watchdog));
  return {
    child, ready, done, work,
    get stdout() { return stdout; }, get stderr() { return stderr; },
    async events(): Promise<{ type: string; pid?: number; childPid?: number; bytes?: number }[]> {
      return (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async close() {
      child.kill('SIGTERM');
      await done;
      await rm(work, { recursive: true, force: true });
    },
  };
}

function protocols(url: URL) {
  return ['mvm-desktop', `mvm-desktop.auth.${new URLSearchParams(url.hash.slice(1)).get('token')}`];
}

function http(url: URL, path: string, host = url.host) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port, path, headers: { Host: host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function connect(url: URL) {
  const socket = new WebSocket(`ws://${url.host}/desktop`, protocols(url), { headers: { Origin: url.origin } });
  const first = once(socket, 'message');
  void first.catch(() => {});
  socket.on('error', () => {});
  await once(socket, 'open');
  const [message] = await first;
  assert.equal(message.toString(), 'RFB 003.008\n');
  return socket;
}

function rejected(url: URL, overrides: { origin?: string | null; host?: string; path?: string; token?: string } = {}) {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = { Host: overrides.host ?? url.host };
    if (overrides.origin !== null) headers.Origin = overrides.origin ?? url.origin;
    const socket = new WebSocket(`ws://${url.host}${overrides.path ?? '/desktop'}`,
      overrides.token ? ['mvm-desktop', `mvm-desktop.auth.${overrides.token}`] : protocols(url), { headers });
    socket.on('error', () => {});
    socket.once('open', () => { socket.terminate(); reject(new Error('Unauthorized WebSocket was accepted.')); });
    socket.once('unexpected-response', (_request, response) => { response.destroy(); socket.terminate(); resolve(response.statusCode!); });
  });
}

async function until(check: () => Promise<boolean>, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= end) throw new Error('Condition was not reached within its deadline.');
    await delay(20);
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('desktop serves embedded assets and requires exact browser authorization before SSH', async () => {
  const f = await fixture();
  try {
    const url = await f.ready;
    const html = await http(url, '/');
    assert.equal(html.status, 200);
    assert.match(html.body, /MicroVM desktop/);
    assert.equal(html.headers['referrer-policy'], 'no-referrer');
    assert.equal(html.headers['cache-control'], 'no-store');
    assert.match(String(html.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal((await http(url, '/client.js')).status, 200);
    assert.match((await http(url, '/licenses.txt')).body, /Mozilla Public License/);
    assert.equal((await http(url, '/', 'evil.example')).status, 403);
    assert.equal((await http(url, '/../package.json')).status, 404);
    for (const options of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: null },
      { host: 'localhost:' + url.port }, { path: '/desktop?anything=1' }, { token: 'x'.repeat(43) }]) {
      assert.equal(await rejected(url, options), 403);
    }
    assert.equal((await f.events()).filter(event => event.type === 'connect').length, 0);
    assert.equal(f.stderr.includes(url.hash.slice(7)), false);
  } finally { await f.close(); }
});

test('authenticated desktop bytes round-trip with backpressure and connection count is bounded', async () => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const url = await f.ready;
    for (let index = 0; index < 4; index++) sockets.push(await connect(url));
    assert.equal(await rejected(url), 429);
    const data = Buffer.alloc(1_048_576, 0x91);
    const chunks: Buffer[] = [];
    let received = 0;
    const response = new Promise<Buffer>(resolve => {
      sockets[0].on('message', chunk => {
        chunks.push(Buffer.from(chunk as Buffer));
        received += (chunk as Buffer).length;
        if (received === data.length) resolve(Buffer.concat(chunks));
      });
    });
    sockets[0].send(data.subarray(0, data.length / 2));
    sockets[0].send(data.subarray(data.length / 2));
    assert.deepEqual(await response, data);
    for (const socket of sockets) socket.close();
    await until(async () => (await f.events()).filter(event => event.type === 'connect').every(event => !alive(event.pid!)));
  } finally { for (const socket of sockets) socket.terminate(); await f.close(); }
});

test('text and oversized desktop frames are refused and SSH children are collected', async () => {
  const f = await fixture();
  try {
    const url = await f.ready;
    const text = await connect(url);
    const textClosed = once(text, 'close');
    text.send('never-forward-this');
    assert.equal((await textClosed)[0], 1003);
    assert.equal((await f.events()).filter(event => event.type === 'input').length, 0);
    const oversized = await connect(url);
    const oversizedClosed = once(oversized, 'close');
    oversized.send(Buffer.alloc(1_048_577));
    assert.ok([1006, 1009].includes((await oversizedClosed)[0]));
    assert.equal((await f.events()).filter(event => event.type === 'input').length, 0);
    await until(async () => (await f.events()).filter(event => event.type === 'connect').every(event => !alive(event.pid!)));
  } finally { await f.close(); }
});

test('desktop input buffering is bounded when SSH stops reading', async () => {
  const f = await fixture({ connect: 'stall-input' });
  let socket: WebSocket | undefined;
  try {
    socket = await connect(await f.ready);
    const closed = once(socket, 'close');
    for (let index = 0; index < 12; index++) socket.send(Buffer.alloc(524_288));
    assert.equal((await closed)[0], 1009);
    await until(async () => (await f.events()).filter(event => event.type === 'connect').every(event => !alive(event.pid!)));
  } finally { socket?.terminate(); await f.close(); }
});

test('a slow viewer backpressures its SSH producer and cancellation removes the listener and child', async () => {
  const f = await fixture({ connect: 'flood' });
  let socket: WebSocket | undefined;
  try {
    const url = await f.ready;
    socket = new WebSocket(`ws://${url.host}/desktop`, protocols(url), { headers: { Origin: url.origin } });
    socket.on('error', () => {});
    await once(socket, 'open');
    socket.pause();
    await delay(300);
    assert.equal((await f.events()).some(event => event.type === 'producer-finished'), false);
    const started = performance.now();
    f.child.kill('SIGTERM');
    assert.equal(await f.done, 0, f.stderr);
    assert.ok(performance.now() - started < 2000);
    await until(async () => (await f.events()).filter(event => event.type === 'connect').every(event => !alive(event.pid!)));
    await assert.rejects(http(url, '/'));
  } finally { socket?.terminate(); await f.close(); }
});

test('aborted desktop preparation kills a stubborn SSH process group before publishing readiness', async () => {
  const f = await fixture({ ensure: 'hang' });
  try {
    await until(async () => (await f.events()).some(event => event.type === 'descendant'));
    const events = await f.events();
    f.child.kill('SIGTERM');
    assert.notEqual(await f.done, 0);
    assert.equal((await f.events()).some(event => event.type === 'prepared'), false);
    await until(async () => events.every(event => (!event.pid || !alive(event.pid)) && (!event.childPid || !alive(event.childPid))));
  } finally { await f.close(); }
});

test('desktop rejects old images and invalid or oversized readiness without leaking raw output', async () => {
  for (const ensure of ['missing', 'invalid', 'oversized']) {
    const f = await fixture({ ensure });
    try {
      assert.notEqual(await f.done, 0);
      assert.equal(f.stdout, '');
      assert.equal(f.stderr.includes('private-error-not-for-user'), false);
      assert.match(f.stderr, ensure === 'missing' ? /DesktopNotInstalled/ : /InvalidDesktopResponse/);
    } finally { await f.close(); }
  }
});

test('a browser opener ignoring SIGTERM is killed at its launch deadline', { timeout: 15_000 }, async () => {
  const f = await fixture({ open: true });
  try {
    const started = performance.now();
    assert.notEqual(await f.done, 0);
    assert.ok(performance.now() - started < 12_500);
    assert.match(f.stderr, /DesktopBrowserFailed/);
    assert.equal(f.stdout, '');
    const openers = (await f.events()).filter(event => event.type === 'opener');
    assert.equal(openers.length, 1);
    assert.equal(alive(openers[0].pid!), false);
  } finally { await f.close(); }
});

test('desktop reports the failed VM startup component without forwarding arbitrary diagnostics', async () => {
  for (const ensure of ['failed-safe', 'failed-unknown']) {
    const f = await fixture({ ensure });
    try {
      assert.notEqual(await f.done, 0);
      assert.equal(f.stdout, '');
      assert.match(f.stderr, /DesktopStartupFailed/);
      assert.equal(f.stderr.includes('private-error-not-for-user'), false);
      assert.equal(f.stderr.includes('DesktopStartFailed:xvnc'), ensure === 'failed-safe');
    } finally { await f.close(); }
  }
});

test('the standalone desktop executable serves its client and license assets from another directory', async () => {
  const f = await fixture({ compiled: true });
  try {
    const url = await f.ready;
    assert.equal((await http(url, '/')).status, 200);
    assert.ok((await http(url, '/client.js')).body.length > 100_000);
    assert.match((await http(url, '/licenses.txt')).body, /noVNC 1\.7\.0/);
    const socket = await connect(url);
    socket.close();
  } finally { await f.close(); }
});

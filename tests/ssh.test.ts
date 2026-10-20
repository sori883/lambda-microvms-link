import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { ManagedShell } from '../src/managed-shell.ts';
import { shellQuote, sshConfig } from '../src/ssh.ts';

const token = 'fixture-token-must-not-appear-in-errors';
const nonce = 'test-bootstrap-nonce';
const marker = Buffer.from(`\x1eMVM_${nonce}:ready\x1f`);

async function fixture(connected: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const protocols: string[] = [];
  server.on('connection', (socket, request) => {
    protocols.push(request.headers['sec-websocket-protocol'] ?? '');
    socket.on('error', () => {});
    connected(socket);
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const shells: ManagedShell[] = [];
  return {
    protocols,
    controller,
    access: { url: new URL(`ws://127.0.0.1:${address.port}/shell`), token },
    async connect() {
      const shell = await ManagedShell.connect(this.access, controller.signal);
      shells.push(shell);
      return shell;
    },
    async close() {
      clearTimeout(timer);
      for (const shell of shells) shell.destroy();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function safeFailure(expectedCode: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok('code' in error);
    assert.equal(error.code, expectedCode);
    assert.equal(String(error).includes(token), false);
    return true;
  };
}

function run(command: string, args: string[], env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('managed shell authenticates on port 8022, excludes control text and preserves bytes after a split bootstrap marker', async () => {
  const trailing = Buffer.concat([Buffer.from('SSH-2.0-test\r\n'), Buffer.from(Array.from({ length: 256 }, (_, index) => index))]);
  let command = Buffer.alloc(0);
  const f = await fixture(socket => {
    socket.send(JSON.stringify({ type: 'session_init', session_id: 'local-fixture' }));
    socket.once('message', (data, binary) => {
      assert.equal(binary, true);
      command = Buffer.from(data as Buffer);
      socket.send(Buffer.concat([Buffer.from('echo and prompt\r\n'), marker.subarray(0, 7)]));
      socket.send(marker.subarray(7, marker.length - 2));
      socket.send(Buffer.concat([marker.subarray(marker.length - 2), trailing]));
    });
  });
  try {
    const shell = await f.connect();
    assert.equal(await shell.bootstrap('stty raw -echo; setup\n', nonce), 'ready');
    assert.equal(command.toString(), 'stty raw -echo; setup\n');
    assert.deepEqual(f.protocols[0].split(',').map(value => value.trim()), [
      'lambda-microvms', `lambda-microvms.authentication.${token}`, 'lambda-microvms.port.8022',
    ]);
    const received = once(shell, 'data');
    shell.resume();
    assert.deepEqual((await received)[0], trailing);
  } finally { await f.close(); }
});

test('managed shell preserves all byte values during multi-megabyte echo to a slow reader', async () => {
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 256;
  const f = await fixture(socket => {
    let initializing = true;
    socket.on('message', (data, binary) => {
      assert.equal(binary, true);
      if (initializing) { initializing = false; socket.send(marker); }
      else socket.send(data, { binary: true });
    });
  });
  try {
    const shell = await f.connect();
    assert.equal(await shell.bootstrap('setup\n', nonce), 'ready');
    const received = createHash('sha256');
    let byteCount = 0;
    const reader = (async () => {
      await delay(30);
      for await (const chunk of shell) {
        byteCount += chunk.length;
        received.update(chunk);
        await delay(1);
        if (byteCount >= payload.length) break;
      }
    })();
    const writer = (async () => {
      for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
        await new Promise<void>((resolve, reject) => shell.write(payload.subarray(offset, offset + 16 * 1024), error => error ? reject(error) : resolve()));
      }
    })();
    await Promise.all([reader, writer]);
    assert.equal(byteCount, payload.length);
    assert.equal(received.digest('hex'), createHash('sha256').update(payload).digest('hex'));
  } finally { await f.close(); }
});

test('managed shell bounds bootstrap output even if an oversized frame contains a complete marker', async () => {
  for (const suffix of [Buffer.alloc(0), marker]) {
    const f = await fixture(socket => socket.once('message', () => socket.send(Buffer.concat([Buffer.alloc(65_537, 65), suffix]))));
    try {
      const shell = await f.connect();
      await assert.rejects(shell.bootstrap('setup\n', nonce), safeFailure('SshBootstrapFailed'));
    } finally { await f.close(); }
  }
});

test('invalid shell control messages and premature close fail without exposing transport secrets', async () => {
  for (const payload of [token, JSON.stringify({ type: 'error', message: token })]) {
    const f = await fixture(socket => socket.once('message', () => socket.send(payload)));
    try {
      const shell = await f.connect();
      await assert.rejects(shell.bootstrap('setup\n', nonce), safeFailure('ShellProtocolError'));
    } finally { await f.close(); }
  }
  const f = await fixture(socket => socket.once('message', () => socket.close(1000, token)));
  try {
    const shell = await f.connect();
    await assert.rejects(shell.bootstrap('setup\n', nonce), safeFailure('SshBootstrapFailed'));
  } finally { await f.close(); }
});

test('unexpected disconnect and cancellation reject bootstrap without echoing token or abort reason', async () => {
  const disconnected = await fixture(socket => socket.once('message', () => socket.terminate()));
  try {
    const shell = await disconnected.connect();
    await assert.rejects(shell.bootstrap('setup\n', nonce), safeFailure('ShellDisconnected'));
  } finally { await disconnected.close(); }
  const aborted = await fixture(socket => socket.once('message', () => aborted.controller.abort(new Error(token))));
  try {
    const shell = await aborted.connect();
    await assert.rejects(shell.bootstrap('setup\n', nonce), safeFailure('Aborted'));
  } finally { await aborted.close(); }
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error(token));
  await assert.rejects(ManagedShell.connect({ url: new URL('ws://127.0.0.1:1/shell'), token }, alreadyAborted.signal), safeFailure('Aborted'));
});

test('a disconnect after bootstrap fails the binary reader instead of reporting a successful EOF', async () => {
  const f = await fixture(socket => {
    let initialized = false;
    socket.on('message', () => {
      if (!initialized) { initialized = true; socket.send(marker); }
      else { socket.send(Buffer.from([0, 255, 13, 10])); socket.close(1008, token); }
    });
  });
  try {
    const shell = await f.connect();
    assert.equal(await shell.bootstrap('setup\n', nonce), 'ready');
    const received = (async () => { for await (const _chunk of shell) {} })();
    shell.write('stream\n');
    await assert.rejects(received, safeFailure('ShellDisconnected'));
  } finally { await f.close(); }
});

test('OpenSSH parses generated configuration and executes ProxyCommand with quoted paths and literal percent arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), "mvm ssh '%-"));
  const script = join(directory, "proxy ' %h.mjs");
  const capture = join(directory, 'argv.json');
  const config = join(directory, 'config');
  const profile = "profile ' %n $(printf unsafe);";
  const extraArgument = "literal ' %h %n $() ;";
  const publicKey = 'ssh-ed25519 AAAATEST fixture';
  try {
    await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.MVM_PROXY_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(config, sshConfig('microvm-local-test', directory, publicKey, { timeout: 1, profile, region: 'us-east-1' }, [process.execPath, script, extraArgument]));
    const parsed = await run('ssh', ['-G', '-F', config, 'mvm']);
    assert.equal(parsed.code, 0, parsed.stderr);
    assert.match(parsed.stdout, /^hostname microvm-local-test$/m);
    assert.match(parsed.stdout, /^hostkeyalias microvm-local-test$/m);
    assert.match(parsed.stdout, /^stricthostkeychecking true$/m);
    assert.match(parsed.stdout, /^identityagent none$/m);
    assert.match(parsed.stdout, /^forwardagent no$/m);
    const executed = await run('ssh', ['-F', config, 'mvm', 'true'], { ...process.env, MVM_PROXY_CAPTURE: capture });
    assert.equal(executed.code, 255, executed.stderr);
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), [
      extraArgument, '--profile', profile, '--region', 'us-east-1', '--timeout', '1', 'ssh-proxy', 'microvm-local-test',
      '--public-key', Buffer.from(publicKey).toString('base64'),
    ]);
    const values = ["apostrophe'", 'spaces and "quotes"', '$(printf unsafe); $HOME', '%h %n', '日本語'];
    const quoted = await run('/bin/sh', ['-c', `printf '%s\\0' ${values.map(shellQuote).join(' ')}`]);
    assert.equal(quoted.code, 0, quoted.stderr);
    assert.deepEqual(quoted.stdout.split('\0').slice(0, -1), values);
    for (const value of ['line\nbreak', 'nul\0byte']) assert.throws(() => shellQuote(value), /control characters/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

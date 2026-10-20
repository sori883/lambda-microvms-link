import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { WebSocketServer } from 'ws';
import { cleanupSessionSsh, prepareSessionSsh } from '../src/session-ssh.ts';
import { SessionStore } from '../src/session-store.ts';

const image = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test';
const hostKey = `ssh-ed25519 ${Buffer.alloc(51, 1).toString('base64')}`;
const changedHostKey = `ssh-ed25519 ${Buffer.alloc(51, 2).toString('base64')}`;
const signal = () => AbortSignal.timeout(10_000);
const options = { timeout: 10 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function reserve(store: SessionStore) {
  const { record } = store.reserve({
    name: 'demo', project: store.root,
    binding: { accountId: '123456789012', region: 'us-east-1' },
    request: { imageIdentifier: image, imageVersion: '3.0', maximumDurationInSeconds: 300, clientToken: randomUUID() },
    source: { image, duration: 300 },
  });
  store.claimRun(record.id);
  store.bind(record.id, 'microvm-test');
  return store.observe(record.id, { state: 'RUNNING', at: new Date().toISOString() });
}

async function fixture(beforeResponse?: () => Promise<void>) {
  const root = await mkdtemp(join('/tmp', "mvm ssh '% space-"));
  const store = new SessionStore(root);
  const record = reserve(store);
  let calls = 0;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => {
    socket.on('error', () => {});
    socket.send(JSON.stringify({ type: 'session_init' }));
    socket.once('message', async data => {
      const nonce = /host-key ([a-f0-9]+);/.exec(data.toString())?.[1];
      assert.ok(nonce);
      calls++;
      await beforeResponse?.();
      if (socket.readyState === 1) socket.send(Buffer.from(`\x1eMVM_${nonce}:${hostKey}\x1f`));
    });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const access = { url: new URL(`ws://127.0.0.1:${address.port}/shell`), token: 'local-token-never-persist' };
  return {
    root, store, record, access, get calls() { return calls; },
    service: { shellAccess: async () => access },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function run(command: string, args: string[], env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('persistent SSH retains identity and pin across store reopen and repairs only its launcher', async () => {
  const f = await fixture();
  try {
    const first = await prepareSessionSsh(f.store, f.record, f.service, options, signal());
    const key = await readFile(join(first.directory, 'identity'));
    const hosts = await readFile(join(first.directory, 'known_hosts'));
    assert.equal(first.alias, `mvm-${f.record.id}`);
    assert.equal((await lstat(first.directory)).mode & 0o777, 0o700);
    for (const name of ['identity', 'identity.pub', 'known_hosts', 'config']) {
      assert.equal((await lstat(join(first.directory, name))).mode & 0o777, 0o600);
    }
    await writeFile(first.config, 'obsolete launcher\n');
    const otherStore = new SessionStore(f.root);
    try {
      const reused = await prepareSessionSsh(otherStore, otherStore.get('demo'), f.service, { ...options, profile: "dev '% profile" }, signal());
      assert.equal(reused.generation, first.generation);
      assert.deepEqual(await readFile(join(first.directory, 'identity')), key);
      assert.deepEqual(await readFile(join(first.directory, 'known_hosts')), hosts);
      assert.equal(f.calls, 1);
      const config = await readFile(first.config, 'utf8');
      assert.match(config, /'--state-dir'/);
      assert.match(config, /'--profile'/);
      assert.match(config, /'session-proxy'/);
      assert.match(config, /StrictHostKeyChecking yes/);
      assert.equal(config.includes('local-token-never-persist'), false);
      const parsed = await run('ssh', ['-G', '-F', first.config, first.alias]);
      assert.equal(parsed.code, 0, parsed.stderr);
      assert.match(parsed.stdout, new RegExp(`hostkeyalias ${first.alias}`));
    } finally { otherStore.close(); }
  } finally { await f.close(); }
});

test('two CLI processes publish one SSH generation and discard only the losing generation', async () => {
  const both = deferred();
  let requests = 0;
  const f = await fixture(async () => { if (++requests === 2) both.resolve(); await both.promise; });
  try {
    const storeModule = fileURLToPath(new URL('../src/session-store.ts', import.meta.url));
    const sshModule = fileURLToPath(new URL('../src/session-ssh.ts', import.meta.url));
    const script = `
      import {SessionStore} from ${JSON.stringify(storeModule)};
      import {prepareSessionSsh} from ${JSON.stringify(sshModule)};
      const store = new SessionStore(process.env.TEST_STATE);
      try {
        const result = await prepareSessionSsh(store, store.get('demo'),
          {shellAccess:async()=>({url:new URL(process.env.TEST_WSS),token:'local-token-never-persist'})},
          {timeout:10}, AbortSignal.timeout(8000));
        console.log(JSON.stringify(result));
      } finally { store.close(); }
    `;
    const env = { ...process.env, TEST_STATE: f.root, TEST_WSS: f.access.url.href };
    const results = await Promise.all([run(process.execPath, ['-e', script], env), run(process.execPath, ['-e', script], env)]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const connections = results.map(result => JSON.parse(result.stdout));
    assert.equal(connections[0].generation, connections[1].generation);
    assert.equal(f.store.get('demo').ssh?.generation, connections[0].generation);
    assert.deepEqual(await readdir(join(f.root, 'ssh', f.record.id)), [connections[0].generation]);
    assert.ok((await readFile(join(connections[0].directory, 'identity'))).length > 0);
  } finally { both.resolve(); await f.close(); }
});

test('stop during SSH preparation prevents publication and cleans the unpublished identity', async () => {
  const requested = deferred();
  const release = deferred();
  const f = await fixture(async () => { requested.resolve(); await release.promise; });
  try {
    const preparation = prepareSessionSsh(f.store, f.record, f.service, options, signal());
    await requested.promise;
    f.store.requestStop(f.record.id);
    release.resolve();
    await assert.rejects(preparation, { code: 'SessionStopped' });
    assert.equal(f.store.get('demo').ssh, undefined);
    assert.deepEqual(await readdir(join(f.root, 'ssh', f.record.id)), []);
    await assert.rejects(prepareSessionSsh(f.store, f.record, f.service, options, signal()), { code: 'SessionStopped' });
    assert.equal(f.calls, 1);
  } finally { release.resolve(); await f.close(); }
});

test('host pin and private-file violations are refused without regenerating SSH material', async () => {
  const f = await fixture();
  try {
    const first = await prepareSessionSsh(f.store, f.record, f.service, options, signal());
    assert.throws(() => f.store.publishSsh(f.record.id, {
      generation: randomUUID(), publicKey: first.publicKey, hostKey: changedHostKey,
    }), { code: 'HostKeyMismatch' });
    const knownHosts = join(first.directory, 'known_hosts');
    await writeFile(knownHosts, `${first.alias} ${changedHostKey}\n`);
    await assert.rejects(prepareSessionSsh(f.store, f.record, f.service, options, signal()), { code: 'SessionSshMismatch' });
    assert.equal(await readFile(knownHosts, 'utf8'), `${first.alias} ${changedHostKey}\n`);
    await writeFile(knownHosts, `${first.alias} ${hostKey}\n`);
    await chmod(join(first.directory, 'identity'), 0o644);
    await assert.rejects(prepareSessionSsh(f.store, f.record, f.service, options, signal()), { code: 'UnsafeSessionFile' });
    assert.equal(f.calls, 1);
  } finally { await f.close(); }
});

test('confirmed stop removes SSH secrets and retains the host pin', async () => {
  const f = await fixture();
  try {
    const connection = await prepareSessionSsh(f.store, f.record, f.service, options, signal());
    await assert.rejects(cleanupSessionSsh(f.store, f.record), { code: 'SessionNotTerminated' });
    f.store.requestStop(f.record.id);
    f.store.observe(f.record.id, { state: 'TERMINATED', at: new Date().toISOString() });
    await cleanupSessionSsh(f.store, f.record);
    await cleanupSessionSsh(f.store, f.record);
    await assert.rejects(lstat(connection.directory), { code: 'ENOENT' });
    const stopped = f.store.get('demo');
    assert.equal(stopped.hostPin, hostKey);
    assert.equal(stopped.ssh, undefined);
    await assert.rejects(prepareSessionSsh(f.store, stopped, f.service, options, signal()), { code: 'SessionStopped' });
  } finally { await f.close(); }
});

test('VS Code uses persistent application settings, preserves JSONC, and reports a missing extension', async () => {
  const f = await fixture();
  try {
    const connection = await prepareSessionSsh(f.store, f.record, f.service, options, signal());
    const sshModule = fileURLToPath(new URL('../src/session-ssh.ts', import.meta.url));
    const executable = join(f.root, 'code');
    const invocation = join(f.root, 'invocation.json');
    await writeFile(executable, `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('--list-extensions')) console.log(process.env.TEST_MISSING_EXTENSION ? 'other.extension' : 'ms-vscode-remote.remote-ssh');
else await Bun.write(process.env.TEST_INVOCATION, JSON.stringify(args));
`, { mode: 0o700 });
    const invoke = async (missing = false) => run(process.execPath, ['-e', `
      import {sessionCode} from ${JSON.stringify(sshModule)};
      try { process.exit(await sessionCode(JSON.parse(process.env.TEST_CONNECTION), AbortSignal.timeout(8000))); }
      catch(error) { console.error(error.code); process.exit(1); }
    `], {
      ...process.env, PATH: `${f.root}:${process.env.PATH}`, TEST_INVOCATION: invocation,
      TEST_CONNECTION: JSON.stringify(connection), ...(missing ? { TEST_MISSING_EXTENSION: '1' } : {}),
    });
    const first = await invoke();
    assert.equal(first.code, 0, first.stderr);
    const settings = join(connection.vscodeDirectory, 'User', 'settings.json');
    const jsonc = '{\n  // user preference\n  "editor.fontSize": 17,\n  "remote.SSH.configFile": "/old",\n}\n';
    await writeFile(settings, jsonc);
    const second = await invoke();
    assert.equal(second.code, 0, second.stderr);
    const updated = await readFile(settings, 'utf8');
    assert.match(updated, /\/\/ user preference/);
    assert.equal(parse(updated)['editor.fontSize'], 17);
    assert.equal(parse(updated)['remote.SSH.configFile'], connection.config);
    assert.equal((await lstat(settings)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(invocation, 'utf8')), [
      '--user-data-dir', connection.vscodeDirectory, '--new-window', '--remote', `ssh-remote+${connection.alias}`, '/workspace',
    ]);
    const missing = await invoke(true);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /RemoteSshExtensionMissing/);
    f.store.observe(f.record.id, { state: 'TERMINATED', at: new Date().toISOString() });
    await cleanupSessionSsh(f.store, f.record);
    assert.equal(await readFile(settings, 'utf8'), updated);
  } finally { await f.close(); }
});

test('VS Code extension inspection has a finite deadline even when its child holds stdout open', async () => {
  const f = await fixture();
  try {
    const connection = await prepareSessionSsh(f.store, f.record, f.service, options, signal());
    const sshModule = fileURLToPath(new URL('../src/session-ssh.ts', import.meta.url));
    await writeFile(join(f.root, 'code'), `#!${process.execPath}
import {spawn} from 'node:child_process';
spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'inherit'});
`, { mode: 0o700 });
    const started = performance.now();
    const result = await run(process.execPath, ['-e', `
      import {sessionCode} from ${JSON.stringify(sshModule)};
      try { await sessionCode(JSON.parse(process.env.TEST_CONNECTION), AbortSignal.timeout(150)); process.exit(0); }
      catch(error) { console.error(error.code); process.exit(1); }
    `], { ...process.env, PATH: `${f.root}:${process.env.PATH}`, TEST_CONNECTION: JSON.stringify(connection) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CodeUnavailable/);
    assert.ok(performance.now() - started < 2_000);
  } finally { await f.close(); }
});

test('VS Code rejects a user-data path exceeding the UTF-8 socket budget before launching code', async () => {
  const f = await fixture();
  try {
    const connection = await prepareSessionSsh(f.store, f.record, f.service, options, signal());
    const longDirectory = join(f.root, '界'.repeat(20));
    assert.ok(longDirectory.length < 80);
    assert.ok(Buffer.byteLength(longDirectory, 'utf8') > 80);
    const invocation = join(f.root, 'unexpected-code-invocation');
    const sshModule = fileURLToPath(new URL('../src/session-ssh.ts', import.meta.url));
    await writeFile(join(f.root, 'code'), `#!${process.execPath}
await Bun.write(process.env.TEST_INVOCATION, 'invoked');
if(process.argv.includes('--list-extensions')) console.log('ms-vscode-remote.remote-ssh');
`, { mode: 0o700 });
    const result = await run(process.execPath, ['-e', `
      import {sessionCode} from ${JSON.stringify(sshModule)};
      try { process.exit(await sessionCode(JSON.parse(process.env.TEST_CONNECTION), AbortSignal.timeout(8000))); }
      catch(error) { console.error(error.code + ': ' + error.message); process.exit(1); }
    `], {
      ...process.env, PATH: `${f.root}:${process.env.PATH}`, TEST_INVOCATION: invocation,
      TEST_CONNECTION: JSON.stringify({ ...connection, vscodeDirectory: longDirectory }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CodePathTooLong/);
    assert.match(result.stderr, /MVM_HOME/);
    await assert.rejects(lstat(longDirectory), { code: 'ENOENT' });
    await assert.rejects(lstat(invocation), { code: 'ENOENT' });
  } finally { await f.close(); }
});

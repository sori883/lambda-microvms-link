import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../src/session-store.ts';

const image = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test';
const key = 'ssh-ed25519 ' + 'A'.repeat(68);
const otherKey = 'ssh-ed25519 ' + 'B'.repeat(68);

function input(name: string, project: string) {
  return {
    name, project, binding: { accountId: '123456789012', region: 'us-east-1' },
    source: { image, imageVersion: '3.0', duration: 300 },
    request: { imageIdentifier: image, imageVersion: '3.0', maximumDurationInSeconds: 300, clientToken: randomUUID() },
  };
}

async function fixture() {
  const work = await mkdtemp(join(tmpdir(), 'mvm-store-test-'));
  const root = join(work, 'state');
  const store = new SessionStore(root);
  return { work, root, store, close: async () => { store.close(); await rm(work, { recursive: true, force: true }); } };
}

test('session names and run claims survive reopening and the state directory is private', async () => {
  const f = await fixture();
  try {
    const first = f.store.reserve(input('demo', f.work));
    assert.equal(first.created, true);
    assert.equal(f.store.reserve(input('demo', f.work)).created, false);
    assert.equal(f.store.reserve(input('trial', f.work)).created, true);
    assert.equal(f.store.list().length, 2);
    const claimed = f.store.claimRun(first.record.id);
    assert.equal(claimed.pending, 'request-unknown');
    assert.ok(claimed.requestedAt);
    assert.throws(() => f.store.claimRun(first.record.id), { code: 'SessionRecoveryRequired' });
    const reopened = new SessionStore(f.root);
    try {
      assert.equal(reopened.get('demo').request.clientToken, first.record.request.clientToken);
      assert.equal(reopened.get('demo').pending, 'request-unknown');
      assert.throws(() => reopened.claimRun(first.record.id), { code: 'SessionRecoveryRequired' });
    } finally { reopened.close(); }
    assert.equal((await stat(f.root)).mode & 0o777, 0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal((await stat(join(f.root, 'sessions.sqlite' + suffix))).mode & 0o777, 0o600);
    }
  } finally { await f.close(); }
});

test('stop intent prevents an unsubmitted run and survives a late VM binding', async () => {
  const f = await fixture();
  try {
    const before = f.store.reserve(input('before', f.work)).record;
    f.store.requestStop(before.id);
    assert.throws(() => f.store.claimRun(before.id), { code: 'SessionRecoveryRequired' });
    assert.equal(f.store.get('before').observed?.state, 'TERMINATED');
    const after = f.store.reserve(input('after', f.work)).record;
    f.store.claimRun(after.id);
    f.store.requestStop(after.id);
    const late = f.store.bind(after.id, 'microvm-late');
    assert.equal(late.desired, 'terminated');
    assert.equal(late.pending, null);
    f.store.observe(after.id, { state: 'TERMINATED', at: new Date().toISOString() });
    f.store.observe(after.id, { state: 'RUNNING', at: new Date().toISOString() });
    assert.equal(f.store.get('after').observed?.state, 'TERMINATED');
  } finally { await f.close(); }
});

test('one VM cannot be assigned to two sessions and an existing binding cannot be replaced', async () => {
  const f = await fixture();
  try {
    const a = f.store.reserve(input('a', f.work)).record;
    const b = f.store.reserve(input('b', f.work)).record;
    f.store.claimRun(a.id);
    f.store.claimRun(b.id);
    f.store.bind(a.id, 'microvm-only');
    assert.throws(() => f.store.bind(b.id, 'microvm-only'), { code: 'VmAlreadyBound' });
    assert.throws(() => f.store.bind(a.id, 'microvm-other'), { code: 'SessionAlreadyBound' });
    assert.equal(f.store.get('b').pending, 'request-unknown');
    assert.equal(f.store.get('b').vmId, undefined);
  } finally { await f.close(); }
});

test('SSH publication keeps the first generation and host pin across cleanup', async () => {
  const f = await fixture();
  try {
    const record = f.store.reserve(input('demo', f.work)).record;
    f.store.claimRun(record.id);
    f.store.bind(record.id, 'microvm-ssh');
    const first = { generation: randomUUID(), publicKey: key, hostKey: key };
    const second = { generation: randomUUID(), publicKey: otherKey, hostKey: key };
    assert.equal(f.store.publishSsh(record.id, first).ssh?.generation, first.generation);
    assert.equal(f.store.publishSsh(record.id, second).ssh?.generation, first.generation);
    assert.throws(() => f.store.publishSsh(record.id, { ...second, hostKey: otherKey }), { code: 'HostKeyMismatch' });
    assert.throws(() => f.store.clearSsh(record.id, first.generation), { code: 'SessionNotTerminated' });
    f.store.requestStop(record.id);
    assert.throws(() => f.store.publishSsh(record.id, first), { code: 'SessionStopped' });
    f.store.observe(record.id, { state: 'TERMINATED', at: new Date().toISOString() });
    assert.equal(f.store.clearSsh(record.id, second.generation), false);
    assert.equal(f.store.clearSsh(record.id, first.generation), true);
    assert.equal(f.store.get('demo').hostPin, key);
    assert.equal(f.store.get('demo').ssh, undefined);
  } finally { await f.close(); }
});

test('separate CLI processes reserve and claim a name exactly once', async () => {
  const work = await mkdtemp(join(tmpdir(), 'mvm-store-race-'));
  const root = join(work, 'state');
  const module = fileURLToPath(new URL('../src/session-store.ts', import.meta.url));
  const run = async () => {
    const script = `
      import { SessionStore } from ${JSON.stringify(module)};
      const store = new SessionStore(${JSON.stringify(root)});
      try {
        const {record} = store.reserve(${JSON.stringify(input('demo', work))});
        try { store.claimRun(record.id); process.stdout.write("claimed"); }
        catch (error) { if (error.code !== "SessionRecoveryRequired") throw error; process.stdout.write("reserved"); }
      } finally { store.close(); }
    `;
    const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    return stdout;
  };
  try {
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.filter(value => value === 'claimed').length, 1);
    assert.equal(results.filter(value => value === 'reserved').length, 2);
    const store = new SessionStore(root);
    try {
      assert.equal(store.list().length, 1);
      assert.equal(store.get('demo').pending, 'request-unknown');
    } finally { store.close(); }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('unsupported schemas and malformed records are rejected without resetting existing data', async () => {
  const f = await fixture();
  try {
    f.store.reserve(input('demo', f.work));
    const db = new Database(join(f.root, 'sessions.sqlite'));
    try {
      db.exec('PRAGMA user_version = 9');
      assert.throws(() => new SessionStore(f.root), { code: 'UnsupportedSessionSchema' });
      assert.equal((db.query('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, 1);
      db.exec('PRAGMA user_version = 1');
      db.query('UPDATE sessions SET record = ?').run(JSON.stringify({ name: 'demo' }));
      assert.throws(() => f.store.get('demo'), { code: 'InvalidSessionStore' });
    } finally { db.close(); }
  } finally { await f.close(); }
});

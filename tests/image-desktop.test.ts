import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const image = process.env.MVM_DESKTOP_TEST_IMAGE;
const exec = promisify(execFile);
const helper = '/usr/local/bin/mvm-desktop';
const root = '/tmp/mvm-desktop-1000';

function run(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 50_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function inspect(container: string) {
  const result = await exec('docker', ['exec', container, 'node', '--input-type=module', '-e', `
import { readdir, readFile, lstat } from 'node:fs/promises';
const processes = [];
for (const pid of (await readdir('/proc')).filter(p => /^\\d+$/.test(p))) {
  try {
    const args = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split(/[\\0\\s]+/);
    const status = await readFile('/proc/' + pid + '/status', 'utf8');
    if (!args[0]?.includes('chromium') && !['Xtigervnc', 'xfce4-session', 'dbus-daemon'].some(n => args[0]?.endsWith(n))) continue;
    processes.push({ pid: Number(pid), args, status, uidMap: await readFile('/proc/' + pid + '/uid_map', 'utf8') });
  } catch {}
}
const sockets = await Promise.all(['control.sock', 'vnc.sock'].map(async name => {
  const info = await lstat('${root}/' + name);
  return { name, mode: info.mode & 511, uid: info.uid, socket: info.isSocket() };
}));
const tcp = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(path => readFile(path, 'utf8')));
const ports = tcp.flatMap(text => text.trim().split('\\n').slice(1)).map(line => line.trim().split(/\\s+/)).filter(fields => fields[3] === '0A').map(fields => parseInt(fields[1].split(':').at(-1), 16));
console.log(JSON.stringify({ processes, sockets, ports, health: (await fetch('http://127.0.0.1:8080/health')).status }));
  `], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout) as {
    processes: { pid: number; args: string[]; status: string; uidMap: string }[];
    sockets: { name: string; mode: number; uid: number; socket: boolean }[];
    ports: number[];
    health: number;
  };
}

async function renderedDesktop(container: string) {
  const deadline = Date.now() + 5_000;
  do {
    const snapshot = await inspect(container);
    if (snapshot.processes.some(process => process.args.includes('--type=renderer'))) return snapshot;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Chromium did not start a renderer after its window became ready.');
}

async function rfbHandshake(container: string, generation: string) {
  const child = spawn('docker', ['exec', '-i', container, helper, 'connect', generation], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  const bytes: Buffer[] = [];
  let size = 0;
  const pending: { count: number; resolve: (data: Buffer) => void }[] = [];
  const consume = () => {
    while (pending.length && size >= pending[0]!.count) {
      const { count, resolve } = pending.shift()!;
      const buffer = Buffer.concat(bytes);
      bytes.length = 0;
      bytes.push(buffer.subarray(count));
      size -= count;
      resolve(buffer.subarray(0, count));
    }
  };
  child.stdout.on('data', chunk => { bytes.push(chunk); size += chunk.length; consume(); });
  const read = (count: number) => Promise.race([
    new Promise<Buffer>(resolve => { pending.push({ count, resolve }); consume(); }),
    delay(5_000).then(() => { throw new Error('RFB timeout: ' + error); }),
  ]);
  try {
    assert.equal((await read(12)).toString(), 'RFB 003.008\n');
    child.stdin.write('RFB 003.008\n');
    assert.deepEqual(await read(2), Buffer.from([1, 1]));
    child.stdin.write(Buffer.from([1]));
    assert.equal((await read(4)).readUInt32BE(), 0);
    child.stdin.write(Buffer.from([1]));
    const init = await read(24);
    assert.equal(init.readUInt16BE(0), 1280);
    assert.equal(init.readUInt16BE(2), 800);
    await read(init.readUInt32BE(20));
  } finally {
    child.stdin.end();
    await Promise.race([closed, delay(3_000).then(() => child.kill())]);
  }
  assert.equal(error, '');
}

test('Docker desktop starts once, uses private Unix sockets and a Chromium sandbox, and survives viewer/browser close', {
  skip: !image, timeout: 90_000,
}, async () => {
  if (!image) return;
  const container = run(['run', '--detach', '--rm', '--security-opt', 'seccomp=unconfined', '--shm-size=256m', image]).trim();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      exec('docker', ['exec', container, helper, 'ensure'], { timeout: 50_000 })));
    for (const result of results) assert.equal(result.stderr, '');
    const readiness = results.map(result => JSON.parse(result.stdout));
    assert.equal(new Set(readiness.map(value => value.generation)).size, 1);
    assert.equal(readiness[0].protocol, 1);
    assert.equal(readiness[0].width, 1280);
    assert.equal(readiness[0].height, 800);
    const generation = readiness[0].generation;
    const snapshot = await renderedDesktop(container);
    assert.equal(snapshot.health, 200);
    assert.deepEqual(snapshot.ports, [8080]);
    for (const socket of snapshot.sockets) {
      assert.equal(socket.mode, 0o600);
      assert.equal(socket.uid, 1000);
      assert.equal(socket.socket, true);
    }
    for (const process of snapshot.processes) assert.match(process.status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
    assert.equal(snapshot.processes.filter(p => p.args[0]?.endsWith('Xtigervnc')).length, 1);
    const browser = snapshot.processes.find(p => p.args[0]?.endsWith('/chromium') && !p.args.some(arg => arg.startsWith('--type=')));
    assert.ok(browser, 'Chromium must have a running browser process.');
    assert.ok(!browser.args.includes('--no-sandbox'));
    const renderers = snapshot.processes.filter(p => p.args.includes('--type=renderer'));
    assert.ok(renderers.length > 0, 'Chromium must start a renderer for its initial page.');
    for (const renderer of renderers) {
      assert.match(renderer.status, /^NoNewPrivs:\s+1$/m);
      assert.match(renderer.status, /^Seccomp:\s+2$/m);
      assert.notEqual(renderer.uidMap, browser.uidMap);
    }
    await Promise.all([rfbHandshake(container, generation), rfbHandshake(container, generation)]);
    await rfbHandshake(container, generation);
    const rejected = spawnSync('docker', ['exec', container, helper, 'connect', randomUUID()], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr.trim(), 'DesktopGenerationUnavailable');
    run(['exec', container, 'kill', '-TERM', String(browser.pid)]);
    await delay(500);
    const reopened = JSON.parse(run(['exec', container, helper, 'ensure']));
    assert.equal(reopened.generation, generation);
    const after = await inspect(container);
    assert.equal(after.processes.find(p => p.args[0]?.endsWith('Xtigervnc'))?.pid, snapshot.processes.find(p => p.args[0]?.endsWith('Xtigervnc'))?.pid);
    assert.ok(after.processes.some(p => p.args[0]?.endsWith('/chromium') && !p.args.some(arg => arg.startsWith('--type=')) && p.pid !== browser.pid));
    await rfbHandshake(container, generation);
  } finally {
    run(['rm', '--force', container]);
  }
});

test('Docker desktop reports sandbox startup failure, reaps its children and leaves unrelated processes alive', {
  skip: !image, timeout: 60_000,
}, async () => {
  if (!image) return;
  const container = run(['run', '--detach', '--rm', image]).trim();
  try {
    const unrelated = run(['exec', container, 'node', '-e', `
const child = require('node:child_process').spawn('sleep', ['100'], { detached: true, stdio: 'ignore' });
console.log(child.pid); child.unref();
    `]).trim();
    const result = await exec('docker', ['exec', container, helper, 'ensure'], { timeout: 45_000 }).then(
      value => ({ ...value, code: 0 }),
      error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /DesktopStartFailed:chromium/);
    const status = run(['exec', container, 'node', '-e', `
const fs = require('node:fs');
const pids = fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p));
const gui = pids.flatMap(pid => { try {
  const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split(/[\\0\\s]+/)[0];
  return /(?:^|\\/)(?:Xtigervnc|chromium|chrome_crashpad_handler|xfce4-session|xfconfd|xfwm4|xfsettingsd|xfce4-panel|xfdesktop|Thunar|ssh-agent|dbus-daemon)$/.test(command) ? [{ pid, command }] : [];
} catch { return []; } });
console.log(JSON.stringify({ gui, unrelated: fs.existsSync('/proc/${unrelated}'), control: fs.existsSync('${root}/control.sock'), health: true }));
    `]);
    const remaining = JSON.parse(status);
    assert.deepEqual(remaining.gui, []);
    assert.equal(remaining.unrelated, true);
    assert.equal(remaining.control, false);
    assert.equal(run(['exec', container, 'curl', '-s', 'http://127.0.0.1:8080/health']).trim(), '{"status":"ok"}');
  } finally {
    run(['rm', '--force', container]);
  }
});

test('Docker desktop waits for a slow first Chromium launch without weakening the sandbox', {
  skip: !image, timeout: 90_000,
}, async () => {
  if (!image) return;
  const container = run(['run', '--detach', '--rm', '--security-opt', 'seccomp=unconfined', '--shm-size=256m', image]).trim();
  try {
    run(['exec', '--user', 'root', container, 'node', '-e', `
const fs = require('node:fs');
fs.renameSync('/usr/bin/chromium', '/usr/bin/chromium-original');
fs.writeFileSync('/usr/bin/chromium', '#!/bin/sh\\nsleep 16\\nexec /usr/bin/chromium-original "$@"\\n', { mode: 0o755 });
    `]);
    const started = Date.now();
    const { stdout, stderr } = await exec('docker', ['exec', container, helper, 'ensure'], { timeout: 80_000 });
    assert.equal(stderr, '');
    assert.equal(JSON.parse(stdout).protocol, 1);
    assert.ok(Date.now() - started >= 16_000);
    await rfbHandshake(container, JSON.parse(stdout).generation);
    const snapshot = await renderedDesktop(container);
    assert.ok(snapshot.processes.some(p => p.args.includes('--type=renderer') && /^Seccomp:\s+2$/m.test(p.status)));
  } finally {
    run(['rm', '--force', container]);
  }
});

test('Docker desktop allows slow display and settings startup within the overall preparation deadline', {
  skip: !image, timeout: 90_000,
}, async () => {
  if (!image) return;
  const container = run(['run', '--detach', '--rm', '--security-opt', 'seccomp=unconfined', '--shm-size=256m', image]).trim();
  try {
    run(['exec', '--user', 'root', container, 'node', '-e', `
const fs = require('node:fs');
for (const [name, seconds] of [['Xtigervnc', 16], ['xdpyinfo', 3], ['xfconf-query', 4]]) {
  const path = '/usr/bin/' + name;
  fs.renameSync(path, path + '-original');
  fs.writeFileSync(path, '#!/bin/sh\\nsleep ' + seconds + '\\nexec ' + path + '-original "$@"\\n', { mode: 0o755 });
}
    `]);
    const started = Date.now();
    const { stdout, stderr } = await exec('docker', ['exec', container, helper, 'ensure'], { timeout: 80_000 });
    assert.equal(stderr, '');
    assert.ok(Date.now() - started >= 20_000);
    const info = JSON.parse(stdout);
    await rfbHandshake(container, info.generation);
    assert.ok((await renderedDesktop(container)).processes.some(p =>
      p.args.includes('--type=renderer') && /^Seccomp:\s+2$/m.test(p.status)));
  } finally {
    run(['rm', '--force', container]);
  }
});

test('Docker desktop detects Chromium exiting while its window probe is still pending', {
  skip: !image, timeout: 30_000,
}, async () => {
  if (!image) return;
  const container = run(['run', '--detach', '--rm', '--security-opt', 'seccomp=unconfined', image]).trim();
  try {
    run(['exec', '--user', 'root', container, 'node', '-e', `
const fs = require('node:fs');
fs.writeFileSync('/usr/bin/chromium', '#!/bin/sh\\nsleep 1\\nexit 42\\n', { mode: 0o755 });
fs.renameSync('/usr/bin/xwininfo', '/usr/bin/xwininfo-original');
fs.writeFileSync('/usr/bin/xwininfo', '#!/bin/sh\\nsleep 30\\nexec /usr/bin/xwininfo-original "$@"\\n', { mode: 0o755 });
    `]);
    const result = await exec('docker', ['exec', container, helper, 'ensure'], { timeout: 8_000 }).then(
      value => ({ ...value, code: 0 }),
      error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /DesktopStartFailed:chromium/);
    const failure = JSON.parse(run(['exec', container, 'cat', `${root}/failure.json`]));
    assert.equal(failure.reason, 'process-exited');
    assert.equal(failure.exitCode, 42);
    assert.ok(failure.elapsedMs < 8_000);
  } finally {
    run(['rm', '--force', container]);
  }
});

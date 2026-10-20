import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const image = process.env.MVM_SSH_TEST_IMAGE;
const helper = fileURLToPath(new URL('../image/mvm-sshd', import.meta.url));
const nonce = '0123456789abcdef0123456789abcdef';
const exec = promisify(execFile);

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('Docker SSH helper carries stdin, preserves the host key and isolates concurrent sessions', { skip: !image }, async () => {
  if (!image) return;
  const work = await mkdtemp(join(tmpdir(), 'mvm-image-ssh-'));
  let container = '';
  try {
    container = run('docker', [
      'run', '--detach', '--rm', '--user', 'root', '--entrypoint', '/bin/sleep',
      '--mount', `type=bind,src=${helper},dst=/usr/local/bin/mvm-sshd,readonly`,
      image, 'infinity',
    ]).trim();
    const identity = join(work, 'identity');
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', identity]);
    const publicKey = run('ssh-keygen', ['-y', '-f', identity]).trim();
    const encoded = Buffer.from(publicKey).toString('base64');
    const readHostKey = () => run('docker', ['exec', container, '/usr/local/bin/mvm-sshd', 'host-key', nonce]);
    const hostResponse = readHostKey();
    const hostMatch = hostResponse.match(/^\x1eMVM_[0-9a-f]{32}:(ssh-ed25519 [A-Za-z0-9+/=]+)\x1f$/);
    assert.ok(hostMatch, 'The helper must return only the framed Ed25519 host key.');
    const knownHosts = join(work, 'known_hosts');
    await writeFile(knownHosts, `mvm-test ${hostMatch[1]}\n`);
    const proxy = join(work, 'proxy.mjs');
    await writeFile(proxy, `
import { spawn } from 'node:child_process';
const child = spawn('docker', ${JSON.stringify(['exec', '-i', container, '/usr/local/bin/mvm-sshd', 'serve', encoded, nonce])}, { stdio: ['pipe', 'pipe', 'inherit'] });
const marker = Buffer.from(${JSON.stringify(`\x1eMVM_${nonce}:ready\x1f`)});
let pending = Buffer.alloc(0), ready = false;
child.stdout.on('data', chunk => {
  if (ready) { process.stdout.write(chunk); return; }
  pending = Buffer.concat([pending, chunk]);
  if (pending.length < marker.length) return;
  if (!pending.subarray(0, marker.length).equals(marker)) { child.kill(); process.exitCode = 1; return; }
  ready = true;
  process.stdout.write(pending.subarray(marker.length));
});
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.on('close', code => { process.stdin.destroy(); process.exitCode = code ?? 1; });
`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const options = [
      '-F', '/dev/null', '-T', '-i', identity,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'HostKeyAlias=mvm-test', '-o', 'IdentitiesOnly=yes',
      '-o', `ProxyCommand=${quote(process.execPath)} ${quote(proxy)}`, 'node@mvm-test',
    ];
    const result = spawnSync('ssh', [...options, 'printf stdin-arrived; printf stderr-arrived >&2; exit 7'], {
      encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'stdin-arrived');
    assert.equal(result.stderr, 'stderr-arrived');
    const sessions = await Promise.all([
      exec('ssh', [...options, 'sleep 0.2; printf first'], { timeout: 15_000 }),
      exec('ssh', [...options, 'sleep 0.2; printf second'], { timeout: 15_000 }),
    ]);
    assert.deepEqual(sessions.map(session => session.stdout), ['first', 'second']);
    assert.equal(readHostKey(), hostResponse);
    let leftovers = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      leftovers = run('docker', ['exec', container, 'find', '/run/mvm-ssh', '-maxdepth', '1', '-name', 'session.*', '-print']);
      if (!leftovers) break;
      await delay(50);
    }
    assert.equal(leftovers, '', 'Completed SSH sessions must remove their own directories.');
  } finally {
    if (container) run('docker', ['rm', '--force', container]);
    await rm(work, { recursive: true, force: true });
  }
});

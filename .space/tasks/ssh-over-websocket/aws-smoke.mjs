import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const binary = resolve('dist/mvm');
const base = ['--profile', 'AdministratorAccess-242201303782', '--region', 'ap-northeast-1'];
const evidence = { at: new Date().toISOString(), binarySha256: hash(await readFile(binary)), checks: [], vms: [] };
const directory = await mkdtemp(join(tmpdir(), 'mvm-ssh-smoke-'));
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function cli(args, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, [...base, ...args], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function success(args, input) {
  const result = await cli(args, input);
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
}
function checked(name, detail = {}) {
  evidence.checks.push({ name, ...detail });
  console.log(JSON.stringify({ name, ...detail }));
}
try {
  const first = JSON.parse((await success(['start', '--image', 'lambda-microvms-link-dev', '--duration', '900', '--json'])).stdout);
  evidence.vms.push({ id: first.microvmId, imageVersion: first.imageVersion });
  const id = first.microvmId;
  console.log(JSON.stringify({ id, imageVersion: first.imageVersion }));
  await success(['check', id, '--json']);
  checked('health');
  const output = await cli(['ssh', id, '--', 'sh', '-c', 'printf ssh-out; printf ssh-err >&2; id -un; exit 7']);
  assert.equal(output.code, 7, JSON.stringify(output));
  assert.equal(output.stdout, 'ssh-outnode\n');
  assert.equal(output.stderr, 'ssh-err');
  checked('stdout-stderr-exit-status');
  const multiline = await success(['ssh', id, '--', 'sh', '-c', "printf 'line 1\\n'\nprintf 'line 2\\n'"]);
  assert.equal(multiline.stdout, 'line 1\nline 2\n');
  checked('multiline-remote-script');

  const payload = randomBytes(4 * 1024 * 1024);
  await writeFile(join(directory, 'source.bin'), payload);
  const transfer = await success(['with-ssh', id, '--', 'sh', '-c',
    'scp -F "$MVM_SSH_CONFIG" "$1/source.bin" mvm:/workspace/roundtrip.bin && scp -F "$MVM_SSH_CONFIG" mvm:/workspace/roundtrip.bin "$1/returned.bin"', 'sh', directory]);
  assert.equal(hash(await readFile(join(directory, 'returned.bin'))), hash(payload));
  checked('scp-sftp-roundtrip', { bytes: payload.length, sha256: hash(payload) });

  await mkdir(join(directory, 'project'));
  await writeFile(join(directory, 'project', 'hello.txt'), 'project sync\n');
  await success(['with-ssh', id, '--', 'sh', '-c',
    'rsync -a -e "ssh -F $MVM_SSH_CONFIG" "$1/project/" mvm:/workspace/project/ && rsync -a -e "ssh -F $MVM_SSH_CONFIG" mvm:/workspace/project/ "$1/copied/"', 'sh', directory]);
  assert.equal(await readFile(join(directory, 'copied', 'hello.txt'), 'utf8'), 'project sync\n');
  checked('rsync-roundtrip');

  const parallel = await Promise.all(['one', 'two'].map(label => success(['ssh', id, '--', 'sh', '-c', `sleep 1; printf ${label}`])));
  assert.deepEqual(parallel.map(result => result.stdout), ['one', 'two']);
  checked('parallel-ssh');

  const wrongHost = await cli(['with-ssh', id, '--', 'sh', '-c',
    'd=$(dirname "$MVM_SSH_CONFIG"); printf "%s " "$1" > "$d/known_hosts"; cat "$d/identity.pub" >> "$d/known_hosts"; ssh -F "$MVM_SSH_CONFIG" mvm true', 'sh', id]);
  assert.equal(wrongHost.code, 255, JSON.stringify(wrongHost));
  assert.match(wrongHost.stderr, /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
  checked('reject-host-key-mismatch');

  const wrongIdentity = await cli(['with-ssh', id, '--', 'sh', '-c',
    'd=$(dirname "$MVM_SSH_CONFIG"); rm "$d/identity" "$d/identity.pub"; ssh-keygen -q -t ed25519 -N "" -f "$d/identity"; ssh -F "$MVM_SSH_CONFIG" mvm true']);
  assert.equal(wrongIdentity.code, 255, JSON.stringify(wrongIdentity));
  assert.match(wrongIdentity.stderr, /Permission denied/);
  checked('reject-wrong-client-key');

  const hostKey = async vmId => (await success(['with-ssh', vmId, '--', 'sh', '-c', 'cat "$(dirname "$MVM_SSH_CONFIG")/known_hosts"'])).stdout.split(' ').slice(1).join(' ');
  const key1 = await hostKey(id);
  const second = JSON.parse((await success(['start', '--image', 'lambda-microvms-link-dev', '--duration', '300', '--json'])).stdout);
  evidence.vms.push({ id: second.microvmId, imageVersion: second.imageVersion });
  const [same, different, concurrent] = await Promise.all([hostKey(id), hostKey(second.microvmId), hostKey(second.microvmId)]);
  assert.equal(same, key1);
  assert.equal(concurrent, different);
  assert.notEqual(different, key1);
  checked('host-key-stability-and-VM-separation');

  const long = await success(['--timeout', '10', 'ssh', id, '--', 'sh', '-c', 'sleep 75; printf still-connected']);
  assert.equal(long.stdout, 'still-connected');
  checked('connection-survives-setup-deadline-and-one-minute-token', { seconds: 75 });
} finally {
  for (const vm of evidence.vms) {
    try { vm.finalState = JSON.parse((await success(['stop', vm.id, '--json'])).stdout).state; }
    catch (error) { vm.cleanupError = String(error); }
  }
  await mkdir(new URL('./evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL('./evidence/aws-smoke.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: evidence.vms }));
}

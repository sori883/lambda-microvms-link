import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const vmId = process.argv[2];
assert.match(vmId ?? '', /^microvm-[a-z0-9-]+$/);
const binary = resolve('dist/mvm');
const base = ['--profile', 'AdministratorAccess-242201303782', '--region', 'ap-northeast-1'];
const evidence = { startedAt: new Date().toISOString(), vmId, steps: [] };
await mkdir('work', { recursive: true });
const directory = await mkdtemp(resolve('work/ssh-demo-'));
await mkdir(join(directory, 'project'));
await mkdir(join(directory, 'download'));

async function cli(label, args) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, [...base, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  evidence.steps.push({ label, args, ...result });
  console.log(label + '\n' + result.stdout + result.stderr);
  assert.equal(result.code, 0, JSON.stringify(result));
  return result.stdout;
}

try {
  await writeFile(join(directory, 'project/message.txt'), 'hello from my local project\n');
  await writeFile(join(directory, 'project/main.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
const message = (await readFile('message.txt', 'utf8')).trim();
const result = { input: message, output: message.toUpperCase(), platform: process.platform, hostname: hostname(), cwd: process.cwd() };
await writeFile('result.json', JSON.stringify(result, null, 2) + '\\n');
console.log(JSON.stringify(result, null, 2));
`);
  evidence.localDirectory = directory;
  console.log('手元のサンプル: ' + join(directory, 'project'));
  await cli('1. VMの状態', ['status', vmId, '--json']);
  await cli('2. SSHでVMの環境を確認', ['ssh', vmId, '--', 'sh', '-lc', 'whoami; uname -s; cd /workspace && pwd']);
  await cli('3. プロジェクトを/workspaceへ転送', ['with-ssh', vmId, '--', 'sh', '-c', 'rsync -av -e "ssh -F \\"$MVM_SSH_CONFIG\\"" "$1/project/" mvm:/workspace/', 'sh', directory]);
  const remote = JSON.parse(await cli('4. VM内でプログラムを実行', ['ssh', vmId, '--', 'sh', '-lc', 'cd /workspace && node main.mjs']));
  assert.equal(remote.platform, 'linux');
  assert.equal(remote.output, 'HELLO FROM MY LOCAL PROJECT');
  await cli('5. 結果を手元へ取得', ['with-ssh', vmId, '--', 'sh', '-c', 'scp -F "$MVM_SSH_CONFIG" mvm:/workspace/result.json "$1/download/result.json"', 'sh', directory]);
  const local = JSON.parse(await readFile(join(directory, 'download/result.json'), 'utf8'));
  assert.deepEqual(local, remote);
  console.log('戻したファイル: ' + join(directory, 'download/result.json'));
  console.log('VMで作った結果と手元のファイルが一致しました。');
  evidence.result = local;
} finally {
  try {
    evidence.finalState = JSON.parse(await cli('6. VMを終了', ['stop', vmId, '--json'])).state;
    assert.equal(evidence.finalState, 'TERMINATED');
  } finally {
    await writeFile(join(directory, 'run.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('実行記録: ' + join(directory, 'run.json'));
  }
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const executable = `${root}dist/mvm`;
const profile = 'AdministratorAccess-242201303782';
const region = 'ap-northeast-1';
const image = 'arn:aws:lambda:ap-northeast-1:242201303782:microvm-image:lambda-microvms-link-dev';
const clientToken = randomUUID();
const evidence = {
  at: new Date().toISOString(), profile, region, image, clientToken,
  executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  steps: [],
};
let id;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_ENDPOINT_URL')));
function invoke(args) {
  const result = spawnSync(executable, ['--profile', profile, '--region', region, '--json', ...args], {
    cwd: '/tmp', env, encoding: 'utf8', timeout: 135_000,
  });
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  const error = result.stderr.trim() ? JSON.parse(result.stderr) : undefined;
  evidence.steps.push({ args, exitCode: result.status, output, error });
  if (output?.microvmId) id = output.microvmId;
  if (error?.error?.recovery?.microvmId) id = error.error.recovery.microvmId;
  assert.equal(result.status, 0, JSON.stringify(error ?? result.error));
  return output;
}
try {
  const started = invoke(['start', '--image', image, '--image-version', '1.0', '--duration', '300', '--client-token', clientToken]);
  assert.equal(started.state, 'RUNNING');
  console.log(JSON.stringify({ step: 'start', microvmId: id, state: started.state }));
  const listed = invoke(['list', '--image', image]);
  assert.ok(listed.microvms.some(vm => vm.microvmId === id));
  const status = invoke(['status', id]);
  assert.equal(status.state, 'RUNNING');
  const check = invoke(['check', id]);
  assert.equal(check.statusCode, 200);
  console.log(JSON.stringify({ step: 'check', microvmId: id, statusCode: check.statusCode }));
} finally {
  try {
    if (id) {
      const stopped = invoke(['stop', id]);
      assert.equal(stopped.state, 'TERMINATED');
      const final = invoke(['status', id]);
      assert.equal(final.state, 'TERMINATED');
      invoke(['stop', id]);
      console.log(JSON.stringify({ step: 'stop', microvmId: id, state: final.state }));
    }
  } finally {
    mkdirSync(`${root}.space/tasks/bun-cli/evidence`, { recursive: true });
    writeFileSync(`${root}.space/tasks/bun-cli/evidence/aws-smoke.json`, JSON.stringify(evidence, null, 2) + '\n');
  }
}

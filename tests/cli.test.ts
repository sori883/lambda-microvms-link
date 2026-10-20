import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { Microvms } from '../src/microvms.ts';

const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const imageArn = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test';
const vm = {
  microvmId: 'microvm-test-1', state: 'RUNNING', endpoint: 'https://vm.example.test',
  imageArn, imageVersion: '1.0', startedAt: 1_792_440_000, maximumDurationInSeconds: 300,
};
type Request = { method: string; url: URL; headers: IncomingHttpHeaders; body: Record<string, unknown> };
type Reply = { status?: number; body: unknown };

async function fixture(handler: (request: Request) => Reply | Promise<Reply>) {
  const work = await mkdtemp(join(tmpdir(), 'mvm-cli-'));
  await writeFile(join(work, 'config'), '');
  await writeFile(join(work, 'credentials'), '');
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = {
      method: request.method!, url: new URL(request.url!, 'http://localhost'), headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
    };
    requests.push(input);
    try {
      const result = await handler(input);
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    } catch {
      response.writeHead(500);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env = {
    PATH: process.env.PATH, HOME: work,
    AWS_CONFIG_FILE: join(work, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(work, 'credentials'),
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'TESTENVKEY', AWS_SECRET_ACCESS_KEY: 'test-secret',
    AWS_SESSION_TOKEN: 'test-session', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_ENDPOINT_URL_LAMBDA_MICROVMS: endpoint,
  };
  function launch(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: work, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { child, done };
  }
  return {
    work, endpoint, requests, launch,
    run: (args: string[], overrides?: NodeJS.ProcessEnv) => launch(args, overrides).done,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await rm(work, { recursive: true, force: true });
    },
  };
}

test('CLI help/version and invalid inputs do not contact AWS; JSON usage errors exit 2', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    const help = await f.run(['--help']);
    assert.equal(help.code, 0);
    for (const command of ['start', 'list', 'status', 'check', 'stop']) assert.match(help.stdout, new RegExp(command));
    const version = await f.run(['--version']);
    assert.equal(version.stdout.trim(), '0.1.0');
    for (const args of [
      ['start'], ['start', '--image', imageArn, '--duration', '0'],
      ['start', '--image', imageArn, '--duration', '28801'],
      ['list', '--timeout', 'NaN'], ['status', 'bad-id'], ['stop'],
      ['check', vm.microvmId, '--port', '65536'], ['check', vm.microvmId, '--path', '//evil.test'],
      ['check', vm.microvmId, '--path', '/\\evil.test'], ['list', '--unknown'], ['list', 'extra'],
      ['session', 'desktop'], ['session', 'desktop', 'demo', '--port', '65536'],
      ['session', 'desktop', 'demo', '--port', '-1'], ['session', 'desktop', 'demo'],
    ]) {
      const result = await f.run([...args, '--json']);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error.code, 'UsageError');
    }
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('real CLI signs environment/session credentials and gathers every list page', async () => {
  const f = await fixture(request => ({ body: request.url.searchParams.has('nextToken')
    ? { items: [{ ...vm, microvmId: 'microvm-test-2', state: 'TERMINATED' }] }
    : { items: [vm], nextToken: 'page-2' } }));
  try {
    const result = await f.run(['list', '--image', imageArn, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout).microvms.map((item: { microvmId: string }) => item.microvmId), ['microvm-test-1', 'microvm-test-2']);
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.match(request.headers.authorization!, /Credential=TESTENVKEY\/.+\/us-east-1\//);
      assert.equal(request.headers['x-amz-security-token'], 'test-session');
      assert.equal(request.url.searchParams.get('imageIdentifier'), imageArn);
    }
  } finally { await f.close(); }
});

test('large JSON output is fully flushed before the CLI exits', async () => {
  const items = Array.from({ length: 20_000 }, (_, index) => ({ ...vm, microvmId: `microvm-test-${index}` }));
  const f = await fixture(() => ({ body: { items } }));
  try {
    const result = await f.run(['list', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.microvms.length, items.length);
    assert.equal(output.microvms.at(-1).microvmId, 'microvm-test-19999');
  } finally { await f.close(); }
});

test('image names resolve through every image page before start and filtered list; missing names never run a VM', async () => {
  const f = await fixture(request => {
    if (request.url.pathname === '/2025-09-09/microvm-images') return { body: request.url.searchParams.has('nextToken')
      ? { items: [{ name: 'test', imageArn }] }
      : { items: [{ name: 'unrelated', imageArn: imageArn + '-other' }], nextToken: 'images-2' } };
    if (request.url.pathname.includes('microvm-images/')) {
      return decodeURIComponent(request.url.pathname).endsWith('/' + imageArn)
        ? { body: { imageArn } }
        : { status: 400, body: { __type: 'ValidationException', message: 'Invalid ARN format' } };
    }
    if (request.method === 'POST') return request.body.imageIdentifier === imageArn
      ? { body: vm }
      : { status: 400, body: { __type: 'ValidationException', message: 'Invalid ARN format' } };
    return { body: { items: request.url.searchParams.get('imageIdentifier') === imageArn ? [vm] : [] } };
  });
  try {
    const started = await f.run(['start', '--image', 'test', '--no-wait', '--json']);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).microvmId, vm.microvmId);
    const listed = await f.run(['list', '--image', 'test', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).microvms.length, 1);
    const before = f.requests.filter(request => request.method === 'POST').length;
    const missing = await f.run(['start', '--image', 'missing', '--no-wait', '--json']);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stderr).error.code, 'ImageNotFound');
    assert.equal(f.requests.filter(request => request.method === 'POST').length, before);
  } finally { await f.close(); }
});

test('shared profiles supply credentials and region; credential_process and AWS_PROFILE use the SDK chain', async () => {
  const f = await fixture(() => ({ body: { items: [] } }));
  try {
    await writeFile(join(f.work, 'credentials'), '[shared]\naws_access_key_id = TESTSHAREDKEY\naws_secret_access_key = shared-secret\naws_session_token = shared-session\n');
    const processFile = join(f.work, 'credentials.mjs');
    await writeFile(processFile, `console.log(JSON.stringify(${JSON.stringify({ Version: 1, AccessKeyId: 'TESTPROCESSKEY', SecretAccessKey: 'process-secret', SessionToken: 'process-session', Expiration: '2099-01-01T00:00:00Z' })}));\n`);
    await writeFile(join(f.work, 'config'), `[profile shared]\nregion = eu-west-1\n[profile process]\nregion = ap-southeast-2\ncredential_process = "${process.execPath}" "${processFile}"\n`);
    const noEnvKeys = { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined, AWS_REGION: undefined };
    const shared = await f.run(['--profile', 'shared', 'list', '--json'], noEnvKeys);
    assert.equal(shared.code, 0, shared.stderr);
    assert.match(f.requests.at(-1)!.headers.authorization!, /Credential=TESTSHAREDKEY\/.+\/eu-west-1\//);
    assert.equal(f.requests.at(-1)!.headers['x-amz-security-token'], 'shared-session');
    const processResult = await f.run(['list', '--json'], { ...noEnvKeys, AWS_PROFILE: 'process' });
    assert.equal(processResult.code, 0, processResult.stderr);
    assert.match(f.requests.at(-1)!.headers.authorization!, /Credential=TESTPROCESSKEY\/.+\/ap-southeast-2\//);
    assert.equal(f.requests.at(-1)!.headers['x-amz-security-token'], 'process-session');
    const regionOverride = await f.run(['list', '--profile', 'shared', '--region', 'us-west-2', '--json'], noEnvKeys);
    assert.equal(regionOverride.code, 0, regionOverride.stderr);
    assert.match(f.requests.at(-1)!.headers.authorization!, /\/us-west-2\//);
    const mixed = await f.run(['list', '--json'], { AWS_PROFILE: 'shared' });
    assert.equal(mixed.code, 0, mixed.stderr);
    assert.equal(mixed.stderr, '');
    assert.match(f.requests.at(-1)!.headers.authorization!, /Credential=TESTSHAREDKEY\//);
    const missingProfile = await f.run(['list', '--profile', 'does-not-exist', '--json']);
    assert.equal(missingProfile.code, 1);
    assert.equal(JSON.parse(missingProfile.stderr).error.code, 'CredentialsProviderError');
  } finally { await f.close(); }
});

test('start waits for RUNNING with a stable client token and bounded lifetime, then stop waits for termination', async () => {
  let phase = 'starting', polls = 0;
  const f = await fixture(request => {
    if (request.url.pathname.includes('microvm-images/')) return { body: { imageArn } };
    if (request.method === 'POST') return { body: { ...vm, state: 'PENDING' } };
    if (request.method === 'DELETE') { phase = 'stopping'; polls = 0; return { body: {} }; }
    polls++;
    return { body: { ...vm, state: phase === 'starting' ? (polls === 1 ? 'PENDING' : 'RUNNING') : (polls === 1 ? 'TERMINATING' : 'TERMINATED') } };
  });
  try {
    const started = await f.run(['start', '--image', imageArn, '--image-version', '1.0', '--duration', '300', '--client-token', 'retry-test-1', '--json']);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).state, 'RUNNING');
    assert.equal(JSON.parse(started.stdout).clientToken, 'retry-test-1');
    const run = f.requests.find(request => request.method === 'POST')!;
    assert.equal(run.body.clientToken, 'retry-test-1');
    assert.equal(run.body.maximumDurationInSeconds, 300);
    assert.equal(run.body.imageVersion, '1.0');
    assert.deepEqual(run.body.ingressNetworkConnectors, ['HTTP_INGRESS', 'SHELL_INGRESS'].map(name => `arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:${name}`));
    assert.equal(run.body.executionRoleArn, undefined);
    const stopped = await f.run(['stop', vm.microvmId, '--json']);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).state, 'TERMINATED');
    const stoppedAgain = await f.run(['stop', vm.microvmId, '--json']);
    assert.equal(stoppedAgain.code, 0, stoppedAgain.stderr);
    assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  } finally { await f.close(); }
});

test('start --no-wait returns the known ID; timeout retains ID and token without terminating the VM', async () => {
  const f = await fixture(request => ({ body: request.url.pathname.includes('microvm-images/') ? { imageArn } : { ...vm, state: 'PENDING' } }));
  try {
    const accepted = await f.run(['start', '--image', imageArn, '--no-wait', '--json']);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).microvmId, vm.microvmId);
    assert.equal(JSON.parse(accepted.stdout).state, 'PENDING');
    const timedOut = await f.run(['start', '--image', imageArn, '--timeout', '1', '--client-token', 'recover-me', '--json']);
    assert.equal(timedOut.code, 1, timedOut.stderr);
    assert.equal(timedOut.stdout, '');
    const error = JSON.parse(timedOut.stderr).error;
    assert.equal(error.code, 'Timeout');
    assert.equal(error.recovery.microvmId, vm.microvmId);
    assert.equal(error.recovery.clientToken, 'recover-me');
    assert.equal(f.requests.some(request => request.method === 'DELETE'), false);
  } finally { await f.close(); }
});

test('SIGINT returns 130 and the known VM ID during start polling', async () => {
  let notifyPoll: () => void = () => {};
  const polled = new Promise<void>(resolve => { notifyPoll = resolve; });
  const f = await fixture(request => {
    if (request.url.pathname.includes('microvm-images/')) return { body: { imageArn } };
    if (request.method === 'GET') notifyPoll();
    return { body: { ...vm, state: 'PENDING' } };
  });
  try {
    const execution = f.launch(['start', '--image', imageArn, '--json']);
    await polled;
    execution.child.kill('SIGINT');
    const result = await execution.done;
    assert.equal(result.code, 130, result.stderr);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'Interrupted');
    assert.equal(error.recovery.microvmId, vm.microvmId);
  } finally { await f.close(); }
});

test('uncertain start errors keep the retry token; AWS errors do not echo response secrets', async () => {
  const f = await fixture(request => request.url.pathname.includes('microvm-images/')
    ? { body: { imageArn } }
    : { status: 403, body: { __type: 'AccessDeniedException', message: 'SECRET-IN-ERROR' } });
  try {
    const result = await f.run(['start', '--image', imageArn, '--client-token', 'retry-once', '--json']);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, 'AccessDeniedException');
    assert.equal(error.recovery.clientToken, 'retry-once');
    assert.equal(error.recovery.microvmId, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-IN-ERROR/);
  } finally { await f.close(); }
});

test('missing credentials and missing region return actionable errors without AWS requests', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    const credentials = await f.run(['list', '--json'], { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined });
    assert.equal(credentials.code, 1);
    assert.equal(JSON.parse(credentials.stderr).error.code, 'CredentialsProviderError');
    const region = await f.run(['list', '--json'], { AWS_REGION: undefined });
    assert.equal(region.code, 1);
    assert.equal(JSON.parse(region.stderr).error.code, 'MissingRegion');
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('the CLI process exits by its deadline even while credential_process is still running', async () => {
  const f = await fixture(() => ({ body: { items: [] } }));
  const pidPath = join(f.work, 'provider.pid');
  try {
    const provider = join(f.work, 'slow-provider.mjs');
    await writeFile(provider, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => console.log(JSON.stringify({Version:1,AccessKeyId:'SLOWKEY',SecretAccessKey:'test'})), 4000);\n`);
    await writeFile(join(f.work, 'config'), `[profile slow]\nregion = us-east-1\ncredential_process = "${process.execPath}" "${provider}"\n`);
    const began = Date.now();
    const result = await f.run(['list', '--profile', 'slow', '--timeout', '1', '--json'], { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'Timeout');
    assert.ok(Date.now() - began < 2500, 'The caller must regain control without waiting for the credential provider.');
    assert.equal(f.requests.length, 0);
  } finally {
    try { process.kill(Number(await readFile(pidPath, 'utf8')), 'SIGTERM'); } catch {}
    await f.close();
  }
});

test('check scopes its token and HTTP request, rejects redirects, and suppresses response and transport secrets', async () => {
  const secret = 'secret-proxy-token';
  let status = 200, failTransport = false, vmState = 'RUNNING', endpoint = 'vm.example.test';
  const f = await fixture(request => ({ body: request.url.pathname.endsWith('/auth-token')
    ? { authToken: { 'X-aws-proxy-auth': secret } }
    : { ...vm, state: vmState, endpoint } }));
  const client = new LambdaMicrovmsClient({ endpoint: f.endpoint, region: 'us-east-1', credentials: { accessKeyId: 'TESTKEY', secretAccessKey: 'test' } });
  let fetchCalls = 0;
  const service = new Microvms(client, AbortSignal.timeout(5_000), async (url, options) => {
    fetchCalls++;
    assert.equal(url.href, 'https://vm.example.test/health');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { 'X-aws-proxy-auth': secret, 'X-aws-proxy-port': '8080' });
    if (failTransport) throw new Error(secret);
    return new Response(secret, { status, headers: { location: 'https://evil.example.test' } });
  });
  try {
    assert.deepEqual(await service.check(vm.microvmId, 8080, '/health'), { microvmId: vm.microvmId, url: 'https://vm.example.test/health', port: 8080, statusCode: 200, ok: true });
    const tokenRequest = f.requests.find(request => request.url.pathname.endsWith('/auth-token'))!;
    assert.deepEqual(tokenRequest.body, { expirationInMinutes: 1, allowedPorts: [{ port: 8080 }] });
    endpoint = 'https://vm.example.test';
    assert.equal((await service.check(vm.microvmId, 8080, '/health')).ok, true);
    const beforeInvalid = fetchCalls;
    for (endpoint of ['http://vm.example.test', 'https://user:password@vm.example.test', 'https://vm.example.test/other']) {
      await assert.rejects(service.check(vm.microvmId, 8080, '/health'), /valid HTTPS endpoint/);
    }
    assert.equal(fetchCalls, beforeInvalid);
    endpoint = 'vm.example.test';
    for (status of [302, 403, 500]) {
      await assert.rejects(service.check(vm.microvmId, 8080, '/health'), error => {
        assert.match(String(error), new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(String(error), new RegExp(secret));
        return true;
      });
    }
    failTransport = true;
    await assert.rejects(service.check(vm.microvmId, 8080, '/health'), /HTTPS connection to the VM failed/);
    const before = fetchCalls;
    vmState = 'TERMINATED';
    await assert.rejects(service.check(vm.microvmId, 8080, '/health'), /requires RUNNING/);
    assert.equal(fetchCalls, before);
  } finally { service.close(); await f.close(); }
});

test('shell access checks state and endpoint, requests a one-minute shell token, and rejects missing tokens', async () => {
  let state = 'RUNNING', endpoint = 'vm.example.test', token: string | undefined = 'shell-secret';
  const f = await fixture(request => ({ body: request.method === 'POST'
    ? { authToken: token ? { 'X-aws-proxy-auth': token } : {} }
    : { ...vm, state, endpoint } }));
  const client = new LambdaMicrovmsClient({ endpoint: f.endpoint, region: 'us-east-1', credentials: { accessKeyId: 'TESTKEY', secretAccessKey: 'test' } });
  const service = new Microvms(client, AbortSignal.timeout(5_000));
  try {
    const access = await service.shellAccess(vm.microvmId);
    assert.equal(access.url.href, 'wss://vm.example.test/shell');
    assert.equal(access.token, token);
    const requested = f.requests.find(request => request.method === 'POST')!;
    assert.match(requested.url.pathname, /shell-auth-token$/);
    assert.deepEqual(requested.body, { expirationInMinutes: 1 });
    token = undefined;
    await assert.rejects(service.shellAccess(vm.microvmId), /required shell token/);
    const before = f.requests.filter(request => request.method === 'POST').length;
    for (endpoint of ['http://vm.example.test', 'https://user:pass@vm.example.test', 'https://vm.example.test/other']) {
      await assert.rejects(service.shellAccess(vm.microvmId), /valid HTTPS endpoint/);
    }
    endpoint = 'vm.example.test';
    state = 'TERMINATED';
    await assert.rejects(service.shellAccess(vm.microvmId), /SSH requires RUNNING/);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, before);
  } finally { service.close(); await f.close(); }
});

test('SSH rejects JSON and invalid keys without contacting AWS; failed preparation cleans temporary keys', async () => {
  const f = await fixture(() => ({ body: { ...vm, state: 'TERMINATED' } }));
  try {
    for (const args of [['ssh', vm.microvmId, '--json'], ['with-ssh', vm.microvmId, '--json', '--', 'true'], ['ssh-proxy', vm.microvmId, '--public-key', 'bad']]) {
      const result = await f.run(args);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, '');
    }
    assert.equal(f.requests.length, 0);
    const result = await f.run(['ssh', vm.microvmId, '--', 'sh', '-c', 'printf test'], { TMPDIR: f.work });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /NotRunning/);
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(f.work)).filter(name => name.startsWith('mvm-ssh-')).length, 0);
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const imageArn = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test';

async function fixture() {
  const work = await mkdtemp(join(tmpdir(), 'mvm-sessions-test-'));
  await writeFile(join(work, 'config'), '');
  await writeFile(join(work, 'credentials'), '');
  let accountId = '123456789012';
  let failRun = false;
  let failGet = false;
  let runs = 0;
  let gets = 0;
  let releaseRun: (() => void) | undefined;
  let receivedRun: (() => void) | undefined;
  let runBarrier: Promise<void> | undefined;
  const vms = new Map<string, Record<string, unknown>>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    if (raw.includes('Action=GetCallerIdentity')) {
      response.setHeader('content-type', 'text/xml');
      response.end(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${accountId}</Account><Arn>arn:aws:iam::${accountId}:user/test</Arn><UserId>test</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`);
      return;
    }
    response.setHeader('content-type', 'application/json');
    const input = JSON.parse(raw || '{}');
    let body: unknown = {};
    if (request.url?.includes('/microvm-images/')) body = { imageArn, latestActiveImageVersion: '3.0' };
    else if (request.method === 'POST' && request.url?.endsWith('/microvms')) {
      runs++;
      const id = `microvm-test-${runs}`;
      body = { microvmId: id, imageArn, imageVersion: input.imageVersion, startedAt: Date.now() / 1000,
        state: 'RUNNING', maximumDurationInSeconds: input.maximumDurationInSeconds, endpoint: 'vm.example.test' };
      vms.set(id, body as Record<string, unknown>);
      receivedRun?.();
      if (runBarrier) await runBarrier;
      if (failRun) { response.statusCode = 403; body = { __type: 'AccessDeniedException', message: 'secret-must-not-escape' }; }
    } else if (request.url?.includes('/microvms/')) {
      const id = decodeURIComponent(request.url.split('/').at(-1)!);
      gets++;
      if (request.method === 'DELETE') vms.get(id)!.state = 'TERMINATED';
      body = vms.get(id) ?? {};
      if (failGet) { response.statusCode = 403; body = { __type: 'AccessDeniedException', message: 'secret-must-not-escape' }; }
    } else if (request.url?.endsWith('/microvms')) body = { items: [...vms.values()] };
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env = {
    PATH: process.env.PATH, HOME: work, MVM_HOME: join(work, 'state'),
    AWS_CONFIG_FILE: join(work, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(work, 'credentials'),
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'TESTKEY', AWS_SECRET_ACCESS_KEY: 'test-secret',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL_LAMBDA_MICROVMS: endpoint, AWS_ENDPOINT_URL_STS: endpoint,
  };
  const launch = (args: string[], overrides: NodeJS.ProcessEnv = {}, json = true) => {
    const child = spawn(process.execPath, [entry, ...(json ? ['--json'] : []), 'session', ...args], { env: { ...env, ...overrides }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = once(child, 'close').then(([code]) =>
      ({ code, stdout, stderr, data: json && stdout ? JSON.parse(stdout) : undefined }));
    return { child, done };
  };
  return {
    work, launch, run: (args: string[]) => launch(args).done,
    get runs() { return runs; }, get gets() { return gets; },
    account(value: string) { accountId = value; }, failRun() { failRun = true; }, failGet() { failGet = true; },
    holdRun() {
      runBarrier = new Promise<void>(resolve => { releaseRun = resolve; });
      return new Promise<void>(resolve => { receivedRun = resolve; });
    },
    releaseRun() { releaseRun?.(); },
    close: async () => { releaseRun?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(work, { recursive: true, force: true }); },
  };
}

test('sessions persist across CLI processes, permit two names per project, and stop idempotently', async () => {
  const f = await fixture();
  try {
    for (const name of ['demo', 'trial']) {
      const result = await f.run(['create', name, '--project', f.work, '--image', imageArn, '--duration', '300']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.data.name, name);
      assert.equal(result.data.state, 'RUNNING');
    }
    const list = await f.run(['list']);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.data.sessions.length, 2);
    assert.equal(f.runs, 2);
    const status = await f.run(['status', 'demo']);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.data.microvmId, 'microvm-test-1');
    for (let i = 0; i < 2; i++) {
      const stopped = await f.run(['stop', 'demo']);
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.equal(stopped.data.state, 'TERMINATED');
    }
    assert.equal(f.runs, 2);
  } finally { await f.close(); }
});

test('concurrent creates reserve a name once and an uncertain run is not automatically repeated', async () => {
  const f = await fixture();
  try {
    f.failRun();
    const args = ['create', 'demo', '--project', f.work, '--image', imageArn];
    const results = await Promise.all([f.run(args), f.run(args)]);
    assert.ok(results.every(result => result.code !== 0));
    assert.equal(f.runs, 1);
    const retry = await f.run(args);
    assert.notEqual(retry.code, 0);
    assert.equal(f.runs, 1);
    assert.ok(results.every(result => !result.stderr.includes('secret-must-not-escape')));
  } finally { await f.close(); }
});

test('session operations reject a changed AWS account before touching the VM', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['create', 'demo', '--project', f.work, '--image', imageArn])).code, 0);
    const before = f.gets;
    f.account('999999999999');
    const result = await f.run(['stop', 'demo']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SessionAccountMismatch/);
    assert.equal(f.gets, before);
    f.account('123456789012');
    assert.equal((await f.run(['status', 'demo'])).data.desired, 'running');
  } finally { await f.close(); }
});

test('a killed create cannot resend Run and explicit recovery keeps the original VM', async () => {
  const f = await fixture();
  try {
    const received = f.holdRun();
    const args = ['create', 'demo', '--project', f.work, '--image', imageArn, '--duration', '300'];
    const creating = f.launch(args);
    await received;
    creating.child.kill('SIGKILL');
    await creating.done;
    f.releaseRun();
    const retry = await f.run(args);
    assert.notEqual(retry.code, 0);
    assert.match(retry.stderr, /SessionRecoveryRequired/);
    assert.equal(f.runs, 1);
    const recovered = await f.run(['recover', 'demo', '--id', 'microvm-test-1']);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(recovered.data.microvmId, 'microvm-test-1');
    assert.equal(recovered.data.state, 'RUNNING');
    assert.equal((await f.run(['stop', 'demo'])).code, 0);
    assert.equal(f.runs, 1);
  } finally { await f.close(); }
});

test('stop during an in-flight create persists its intent and the created VM is terminated', async () => {
  const f = await fixture();
  try {
    const received = f.holdRun();
    const creating = f.launch(['create', 'demo', '--project', f.work, '--image', imageArn]);
    await received;
    const stopping = await f.run(['stop', 'demo']);
    assert.notEqual(stopping.code, 0);
    assert.match(stopping.stderr, /SessionRecoveryRequired/);
    f.releaseRun();
    const created = await creating.done;
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.data.state, 'TERMINATED');
    assert.equal(f.runs, 1);
  } finally { await f.close(); }
});

test('list reports an AWS refresh failure as UNKNOWN rather than cached RUNNING', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['create', 'demo', '--project', f.work, '--image', imageArn])).code, 0);
    f.failGet();
    const result = await f.run(['list']);
    assert.equal(result.code, 1);
    assert.equal(result.data.sessions[0].state, 'UNKNOWN');
    assert.equal(result.data.sessions[0].error.code, 'AccessDeniedException');
    assert.ok(!result.stdout.includes('secret-must-not-escape'));
  } finally { await f.close(); }
});

test('a rejected account change cannot leave a stop intent during VM creation', async () => {
  const f = await fixture();
  try {
    const received = f.holdRun();
    const creating = f.launch(['create', 'demo', '--project', f.work, '--image', imageArn]);
    await received;
    f.account('999999999999');
    const stopping = await f.run(['stop', 'demo']);
    assert.notEqual(stopping.code, 0);
    assert.match(stopping.stderr, /SessionAccountMismatch/);
    f.account('123456789012');
    f.releaseRun();
    const created = await creating.done;
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.data.state, 'RUNNING');
    assert.equal(created.data.desired, 'running');
  } finally { await f.close(); }
});

test('session SSH setup times out while credential_process is still pending', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(['create', 'demo', '--project', f.work, '--image', imageArn])).code, 0);
    const script = join(f.work, 'slow-auth.mjs');
    await writeFile(script, 'setTimeout(() => process.exit(1), 3000);\n');
    await writeFile(join(f.work, 'config'), `[default]\ncredential_process = "${process.execPath}" "${script}"\n`);
    const started = Date.now();
    const result = await f.launch(['ssh', 'demo', '--timeout', '1'], {
      AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined,
    }, false).done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Timeout/);
    assert.ok(Date.now() - started < 2500);
  } finally { await f.close(); }
});

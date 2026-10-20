import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { Microvms, OperationError } from './microvms.ts';
import { type SessionRecord, SessionStore } from './session-store.ts';
import { argumentQuote, child, connectionConfig, remoteHostKey, selfCommand, type SshOptions } from './ssh.ts';

export type PreparedSessionSsh = {
  id: string;
  generation: string;
  alias: string;
  directory: string;
  config: string;
  publicKey: string;
  vscodeDirectory: string;
};

function active(record: SessionRecord) {
  if (record.desired !== 'running' || record.observed?.state === 'TERMINATED') {
    throw new OperationError('SessionStopped', 'This session has stopped. Create a session with a different name.');
  }
  if (!record.vmId) throw new OperationError('SessionNotBound', 'This session does not have a confirmed VM. Recover its VM before connecting.');
}

function sessionDirectory(store: SessionStore, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new OperationError('InvalidSessionId', 'The saved session ID is invalid.');
  return join(store.root, 'ssh', id);
}

function prepared(store: SessionStore, record: SessionRecord): PreparedSessionSsh {
  active(record);
  if (!record.ssh || !/^[a-f0-9-]{36}$/.test(record.ssh.generation)) {
    throw new OperationError('SessionSshMissing', 'This session does not have prepared SSH settings.');
  }
  const directory = join(sessionDirectory(store, record.id), record.ssh.generation);
  return {
    id: record.id, generation: record.ssh.generation, alias: `mvm-${record.id}`,
    directory, config: join(directory, 'config'), publicKey: record.ssh.publicKey,
    vscodeDirectory: join(store.root, 'vscode', record.id),
  };
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new OperationError('UnsafeSessionFile', 'Session directories must be owned by the current user and must not be symbolic links.');
  }
  await chmod(path, 0o700);
}

async function privateFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new OperationError('UnsafeSessionFile', 'Session files must be private regular files owned by the current user.');
  }
}

async function atomicWrite(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function configuration(store: SessionStore, record: SessionRecord, connection: PreparedSessionSsh, options: SshOptions) {
  return connectionConfig(record.vmId!, connection.directory, options.timeout, connection.alias, connection.alias, [
    ...selfCommand(), '--state-dir', store.root, ...(options.profile ? ['--profile', options.profile] : []), '--timeout', String(options.timeout),
    'session-proxy', record.id, '--generation', connection.generation,
  ]);
}

async function reuse(store: SessionStore, record: SessionRecord, options: SshOptions, signal: AbortSignal) {
  const connection = prepared(store, record);
  await privateDirectory(join(store.root, 'ssh'));
  await privateDirectory(sessionDirectory(store, record.id));
  const directoryInfo = await lstat(connection.directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0 ||
    (process.getuid && directoryInfo.uid !== process.getuid())) {
    throw new OperationError('UnsafeSessionFile', 'The saved SSH directory is not private.');
  }
  for (const name of ['identity', 'identity.pub', 'known_hosts']) await privateFile(join(connection.directory, name));
  const publicKey = (await readFile(join(connection.directory, 'identity.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  const hosts = await readFile(join(connection.directory, 'known_hosts'), 'utf8');
  if (publicKey !== record.ssh!.publicKey || record.hostPin !== record.ssh!.hostKey || hosts !== `${connection.alias} ${record.ssh!.hostKey}\n`) {
    throw new OperationError('SessionSshMismatch', 'Saved SSH keys or host pin do not match the session. They will not be replaced automatically.');
  }
  signal.throwIfAborted();
  const current = store.getById(record.id);
  active(current);
  if (current.ssh?.generation !== connection.generation) throw new OperationError('SessionSshChanged', 'The SSH generation is no longer active.');
  await atomicWrite(connection.config, configuration(store, current, connection, options));
  return connection;
}

export async function prepareSessionSsh(
  store: SessionStore, record: SessionRecord, service: Pick<Microvms, 'shellAccess'>, options: SshOptions, signal: AbortSignal,
): Promise<PreparedSessionSsh> {
  if (process.platform === 'win32') throw new OperationError('UnsupportedPlatform', 'SSH currently requires macOS or Linux with OpenSSH.');
  record = store.getById(record.id);
  active(record);
  if (record.ssh) return reuse(store, record, options, signal);
  await privateDirectory(join(store.root, 'ssh'));
  await privateDirectory(sessionDirectory(store, record.id));
  const generation = randomUUID();
  const directory = join(sessionDirectory(store, record.id), generation);
  await mkdir(directory, { mode: 0o700 });
  let published = false;
  try {
    const identity = join(directory, 'identity');
    if (await child('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'mvm-session', '-f', identity], signal, false) !== 0) {
      throw new OperationError('SshKeyGenerationFailed', 'Could not create the session SSH identity.');
    }
    await chmod(identity, 0o600);
    await chmod(identity + '.pub', 0o600);
    const publicKey = (await readFile(identity + '.pub', 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
    const hostKey = await remoteHostKey(service, record.vmId!, signal);
    const candidate = { generation, publicKey, hostKey };
    const connection = prepared(store, { ...record, ssh: candidate });
    await atomicWrite(join(directory, 'known_hosts'), `${connection.alias} ${hostKey}\n`);
    await atomicWrite(connection.config, configuration(store, record, connection, options));
    signal.throwIfAborted();
    const winner = store.publishSsh(record.id, candidate);
    published = winner.ssh?.generation === generation;
    if (published) return connection;
    await rm(directory, { recursive: true, force: true });
    return await reuse(store, winner, options, signal);
  } finally {
    if (!published) await rm(directory, { recursive: true, force: true });
  }
}

export async function cleanupSessionSsh(store: SessionStore, record: SessionRecord) {
  const current = store.getById(record.id);
  if (current.observed?.state !== 'TERMINATED') {
    throw new OperationError('SessionNotTerminated', 'SSH files can only be removed after AWS confirms that the VM has terminated.');
  }
  await rm(sessionDirectory(store, current.id), { recursive: true, force: true });
  if (current.ssh) store.clearSsh(current.id, current.ssh.generation);
}

export async function sessionSsh(connection: PreparedSessionSsh, args: string[], signal: AbortSignal, local = false) {
  if (local) {
    if (!args.length) throw new OperationError('MissingLocalCommand', 'Provide a local command after --.');
    return child(args[0], args.slice(1), signal, true, {
      ...process.env, MVM_SSH_CONFIG: connection.config, MVM_SSH_HOST: connection.alias,
    });
  }
  const remoteCommand = args.length ? args.map(argumentQuote).join(' ') : 'cd /workspace && exec "${SHELL:-/bin/sh}" -l';
  return child('ssh', ['-F', connection.config, ...(!args.length ? ['-t'] : []), connection.alias, remoteCommand], signal, true);
}

async function codeExtensions(directory: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const command = spawn('code', ['--user-data-dir', directory, '--list-extensions'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let output = '';
    const abort = () => { if (command.pid) { try { process.kill(-command.pid, 'SIGKILL'); } catch {} } };
    signal.addEventListener('abort', abort, { once: true });
    command.stdout.setEncoding('utf8');
    command.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1_048_576) abort();
    });
    command.once('error', () => reject(new OperationError('CodeUnavailable', 'Install the code command in PATH to open VS Code.')));
    command.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (code === 0 && !signal.aborted && output.length <= 1_048_576) resolve(output);
      else reject(new OperationError('CodeUnavailable', 'Could not inspect VS Code extensions within the time limit.'));
    });
    if (signal.aborted) abort();
  });
}

export async function sessionCode(connection: PreparedSessionSsh, signal: AbortSignal) {
  if (Buffer.byteLength(connection.vscodeDirectory, 'utf8') > 80) {
    throw new OperationError('CodePathTooLong', 'The VS Code session directory is too long for its Unix socket. Move the existing session state to a shorter MVM_HOME or --state-dir path, then run session code again.');
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const settings = join(connection.vscodeDirectory, 'User', 'settings.json');
  await privateDirectory(dirname(connection.vscodeDirectory));
  await privateDirectory(connection.vscodeDirectory);
  await privateDirectory(dirname(settings));
  let content = '{}\n';
  try {
    await privateFile(settings);
    content = await readFile(settings, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const errors: ParseError[] = [];
  const value = parse(content, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('InvalidCodeSettings', 'The session VS Code User/settings.json must contain a valid JSONC object.');
  }
  content = applyEdits(content, modify(content, ['remote.SSH.configFile'], connection.config, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  }));
  await atomicWrite(settings, content);
  const extensions = await codeExtensions(connection.vscodeDirectory, bounded);
  if (!extensions.split(/\r?\n/).some(extension => extension.toLowerCase() === 'ms-vscode-remote.remote-ssh')) {
    throw new OperationError('RemoteSshExtensionMissing', 'Install the ms-vscode-remote.remote-ssh extension in VS Code, then run session code again.');
  }
  const result = await child('code', [
    '--user-data-dir', connection.vscodeDirectory, '--new-window', '--remote', `ssh-remote+${connection.alias}`, '/workspace',
  ], bounded, true);
  if (bounded.aborted) throw new OperationError('CodeLaunchTimeout', 'VS Code did not finish launching within the time limit.');
  return result;
}

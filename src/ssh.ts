import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedShell } from './managed-shell.ts';
import { Microvms, OperationError } from './microvms.ts';

export type SshOptions = { profile?: string; region?: string; timeout: number };

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OperationError('Aborted', 'SSH operation aborted.'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function shellQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new OperationError('InvalidSshPath', 'SSH paths and options must not contain control characters.');
  return argumentQuote(value);
}

export function argumentQuote(value: string): string {
  if (value.includes('\0')) throw new OperationError('InvalidSshArgument', 'SSH arguments must not contain NUL.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function configQuote(value: string) {
  shellQuote(value);
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
}

export async function child(command: string, args: string[], signal: AbortSignal, inherit: boolean, env = process.env): Promise<number> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const processChild = spawn(command, args, { stdio: inherit ? 'inherit' : 'ignore', env, detached: true });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (kind: NodeJS.Signals) => {
      if (processChild.pid) { try { process.kill(-processChild.pid, kind); } catch {} }
    };
    const abort = () => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), 1_000);
    };
    const resize = () => killGroup('SIGWINCH');
    signal.addEventListener('abort', abort, { once: true });
    process.on('SIGWINCH', resize);
    processChild.once('error', () => reject(new OperationError('LocalCommandFailed', 'Could not start the local command. Check that ssh and ssh-keygen, or the requested tool, are installed.')));
    processChild.once('close', (code, killedBy) => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      process.removeListener('SIGWINCH', resize);
      resolve(code ?? (killedBy === 'SIGINT' ? 130 : 1));
    });
    if (signal.aborted) abort();
  });
}

export async function remoteHostKey(service: Pick<Microvms, 'shellAccess'>, id: string, signal: AbortSignal) {
  const access = await abortable(service.shellAccess(id), signal);
  const shell = await ManagedShell.connect(access, signal);
  const nonce = randomBytes(16).toString('hex');
  try {
    const key = await shell.bootstrap(`stty raw -echo; /usr/local/bin/mvm-sshd host-key ${nonce}; exit\n`, nonce);
    if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(key)) throw new OperationError('InvalidHostKey', 'The VM did not return a valid Ed25519 host key.');
    return key;
  } finally { shell.destroy(); }
}

export function sshConfig(id: string, directory: string, publicKey: string, options: SshOptions, self: string[]) {
  const args = [...self];
  if (options.profile) args.push('--profile', options.profile);
  if (options.region) args.push('--region', options.region);
  args.push('--timeout', String(options.timeout), 'ssh-proxy', id, '--public-key', Buffer.from(publicKey).toString('base64'));
  return connectionConfig(id, directory, options.timeout, 'mvm', id, args);
}

export function selfCommand(): string[] {
  const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
  return entry.includes('/$bunfs/') ? [process.execPath] : [process.execPath, entry];
}

export function connectionConfig(id: string, directory: string, timeout: number, alias: string, hostKeyAlias: string, args: string[]) {
  if (![id, alias, hostKeyAlias].every(value => /^[A-Za-z0-9_.-]+$/.test(value))) {
    throw new OperationError('InvalidSshTarget', 'SSH target names must contain only letters, numbers, dots, underscores, and hyphens.');
  }
  const proxy = args.map(shellQuote).join(' ').replaceAll('%', '%%');
  return [
    `Host ${alias}`, `  HostName ${id}`, '  User node', `  HostKeyAlias ${hostKeyAlias}`,
    `  IdentityFile ${configQuote(join(directory, 'identity'))}`,
    `  UserKnownHostsFile ${configQuote(join(directory, 'known_hosts'))}`,
    '  GlobalKnownHostsFile /dev/null', '  StrictHostKeyChecking yes', '  CheckHostIP no',
    '  IdentitiesOnly yes', '  IdentityAgent none', '  BatchMode yes', '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no', '  ForwardAgent no', '  ForwardX11 no',
    '  ControlMaster no', '  ControlPath none', '  ServerAliveInterval 15', '  ServerAliveCountMax 3',
    `  ConnectTimeout ${timeout}`, `  ProxyCommand ${proxy}`, '',
  ].join('\n');
}

export async function withSsh(
  service: Microvms, id: string, options: SshOptions, args: string[], local: boolean,
  signal: AbortSignal, prepared: () => void,
): Promise<number> {
  if (process.platform === 'win32') throw new OperationError('UnsupportedPlatform', 'SSH currently requires macOS or Linux with OpenSSH.');
  const directory = await mkdtemp(join(tmpdir(), 'mvm-ssh-'));
  try {
    const identity = join(directory, 'identity');
    if (await child('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'mvm-session', '-f', identity], signal, false) !== 0) {
      throw new OperationError('SshKeyGenerationFailed', 'Could not create the temporary SSH identity.');
    }
    const publicKey = (await readFile(identity + '.pub', 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
    const hostKey = await remoteHostKey(service, id, signal);
    signal.throwIfAborted();
    const config = join(directory, 'config');
    await writeFile(join(directory, 'known_hosts'), `${id} ${hostKey}\n`, { mode: 0o600 });
    await writeFile(config, sshConfig(id, directory, publicKey, options, selfCommand()), { mode: 0o600 });
    prepared();
    if (local) return await child(args[0], args.slice(1), signal, true, { ...process.env, MVM_SSH_CONFIG: config, MVM_SSH_HOST: 'mvm' });
    const remoteCommand = args.length ? args.map(argumentQuote).join(' ') : undefined;
    return await child('ssh', ['-F', config, 'mvm', ...(remoteCommand ? [remoteCommand] : [])], signal, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function sshProxy(service: Microvms, id: string, publicKey: string, signal: AbortSignal, prepared: () => void) {
  const access = await abortable(service.shellAccess(id), signal);
  const shell = await ManagedShell.connect(access, signal);
  const nonce = randomBytes(16).toString('hex');
  try {
    const result = await shell.bootstrap(`stty raw -echo; exec /usr/local/bin/mvm-sshd serve ${shellQuote(publicKey)} ${nonce}\n`, nonce);
    if (result !== 'ready') throw new OperationError('SshBootstrapFailed', 'The VM could not start SSH.');
    prepared();
    process.stdin.pipe(shell);
    for await (const chunk of shell) {
      await abortable(new Promise<void>((resolve, reject) => process.stdout.write(chunk, error => error ? reject(error) : resolve())), signal);
    }
  } finally {
    process.stdin.unpipe(shell);
    process.stdin.pause();
    shell.destroy();
  }
}

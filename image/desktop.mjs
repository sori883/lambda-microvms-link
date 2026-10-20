import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const uid = process.getuid();
const root = `/tmp/mvm-desktop-${uid}`;
const controlPath = join(root, 'control.sock');
const vncPath = join(root, 'vnc.sock');
const failurePath = join(root, 'failure.json');
const timeout = 90_000;
const recoveryGrace = 5_000;
const size = { protocol: 1, width: 1280, height: 800 };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
process.umask(0o077);

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077)) {
    throw new Error('DesktopUnsafeDirectory');
  }
}

function line(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('DesktopControlTimeout')), 4_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', failed);
      socket.off('end', ended);
      if (error) reject(error);
      else resolve(value);
    };
    const failed = () => finish(new Error('DesktopUnavailable'));
    const ended = () => finish(new Error('DesktopUnavailable'));
    const data = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end > 1024 || (end < 0 && buffered.length > 1024)) {
        finish(new Error('DesktopInvalidControl'));
        return;
      }
      if (end < 0) return;
      socket.pause();
      if (buffered.length > end + 1) socket.unshift(buffered.subarray(end + 1));
      try {
        finish(null, JSON.parse(buffered.subarray(0, end).toString()));
      } catch {
        finish(new Error('DesktopInvalidControl'));
      }
    };
    socket.on('data', data);
    socket.once('error', failed);
    socket.once('end', ended);
  });
}

async function request(action, generation) {
  const socket = createConnection(controlPath);
  socket.on('error', () => {});
  try {
    const response = line(socket);
    socket.write(JSON.stringify({ action, generation }) + '\n');
    return await response;
  } finally {
    socket.destroy();
  }
}

async function ensureLocked() {
  const started = Date.now();
  let launched = false;
  while (Date.now() - started < timeout + recoveryGrace) {
    let status;
    try {
      status = await request('ensure');
    } catch {}
    if (status?.state === 'ready') {
      process.stdout.write(JSON.stringify({ ...size, generation: status.generation }) + '\n');
      return;
    }
    if (status?.state === 'failed') throw new Error(status.error || 'DesktopStartFailed');
    if (!status && !launched) {
      await rm(failurePath, { force: true });
      const supervisor = spawn('flock', [
        '--exclusive', '--nonblock', '--close', join(root, 'supervisor.lock'),
        process.execPath, script, '_supervise',
      ], { detached: true, stdio: 'ignore' });
      supervisor.on('error', () => {});
      supervisor.unref();
      launched = true;
    }
    if (!status && launched) {
      try {
        const failure = JSON.parse(await readFile(failurePath, 'utf8'));
        if (failure.at >= started) throw new Error(failure.error);
      } catch (error) {
        if (error.message.startsWith('DesktopStartFailed')) throw error;
      }
    }
    await delay(100);
  }
  throw new Error('DesktopStartTimeout');
}

async function connect(generation) {
  if (!uuid.test(generation || '')) throw new Error('DesktopInvalidGeneration');
  const socket = createConnection(controlPath);
  socket.on('error', () => {});
  const exit = () => socket.destroy();
  process.once('SIGTERM', exit);
  process.once('SIGINT', exit);
  try {
    const response = line(socket);
    socket.write(JSON.stringify({ action: 'connect', generation }) + '\n');
    const result = await response;
    if (!result.ok) throw new Error('DesktopGenerationUnavailable');
    const closed = once(socket, 'close');
    process.stdin.on('error', exit);
    process.stdout.on('error', exit);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    await closed;
  } finally {
    process.stdin.unpipe(socket);
    process.stdin.destroy();
    socket.destroy();
    process.off('SIGTERM', exit);
    process.off('SIGINT', exit);
  }
}

async function supervise() {
  const started = Date.now();
  const deadline = started + timeout;
  const generation = randomUUID();
  const children = new Set();
  const viewers = new Set();
  const authority = join(root, 'Xauthority');
  const runtime = join(root, 'runtime');
  const config = join(root, 'config');
  const logs = new Map();
  let state = 'starting';
  let stopping = false;
  let browser;
  let browserStarting;
  let browserReady = false;
  let env;
  let stage = 'desktop';
  const status = () => ({ state, generation });
  const server = createServer(async socket => {
    viewers.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => viewers.delete(socket));
    try {
      const message = await line(socket);
      if (message.action === 'ensure') {
        if (state === 'ready' && !browserReady) await ensureBrowser();
        socket.end(JSON.stringify(status()) + '\n');
      } else if (message.action === 'connect' && state === 'ready' && message.generation === generation) {
        const vnc = createConnection(vncPath);
        vnc.on('error', () => socket.destroy());
        socket.on('close', () => vnc.destroy());
        vnc.on('close', () => socket.destroy());
        await once(vnc, 'connect');
        socket.write('{"ok":true}\n');
        socket.pipe(vnc);
        vnc.pipe(socket);
      } else {
        socket.end('{"ok":false}\n');
      }
    } catch {
      socket.end('{"state":"failed","error":"DesktopStartFailed"}\n');
    }
  });

  async function stop(component, details = {}) {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    state = 'failed';
    for (const viewer of viewers) viewer.destroy();
    server.close();
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    await delay(500);
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    if (component) {
      await writeFile(failurePath, JSON.stringify({
        at: Date.now(), generation, error: `DesktopStartFailed:${component}`,
        stage: component, elapsedMs: Date.now() - started, ...details,
      }), { mode: 0o600 }).catch(() => {});
    }
    await Promise.all([rm(controlPath, { force: true }), rm(vncPath, { force: true })]);
    process.exit(component ? 1 : 0);
  }

  function launch(name, command, args, required = true, stdio = ['ignore', 'pipe', 'pipe']) {
    const child = spawn(command, args, { env, detached: true, stdio });
    children.add(child);
    logs.set(name, '');
    const log = chunk => logs.set(name, (logs.get(name) + chunk.toString()).slice(-8192));
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('error', () => {
      children.delete(child);
      if (required) void stop(name, { reason: 'spawn-failed' });
    });
    child.on('exit', (code, signal) => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      children.delete(child);
      if (child === browser) browserReady = false;
      if (required && !stopping) void stop(name, { reason: 'process-exited', exitCode: code, signal });
    });
    return child;
  }

  function failed(component, reason, details = {}) {
    return Object.assign(new Error(component), { details: { reason, ...details } });
  }

  async function runCommand(component, command, args, until, signal) {
    if (stopping || Date.now() >= until) throw failed(component, 'timeout');
    const pending = exec(command, args, {
      env, detached: true, timeout: Math.max(1, until - Date.now()), killSignal: 'SIGKILL', signal,
    });
    const child = pending.child;
    children.add(child);
    child.once('exit', () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      children.delete(child);
    });
    child.once('error', () => children.delete(child));
    try {
      return await pending;
    } catch (error) {
      throw failed(component, error.killed ? 'timeout' : 'command-failed', {
        exitCode: typeof error.code === 'number' ? error.code : null,
        signal: error.signal ?? null,
      });
    }
  }

  async function waitUntil(probe, component, until) {
    while (!stopping && Date.now() < until) {
      if (await probe()) return;
      await delay(100);
    }
    throw failed(component, 'timeout');
  }

  async function ensureBrowser(until = Date.now() + timeout) {
    if (browserReady) return;
    if (browserStarting) return browserStarting;
    browserStarting = (async () => {
      browser = launch('chromium', '/usr/bin/chromium', [
        `--user-data-dir=${join(root, 'chromium')}`,
        '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
        'about:blank',
      ], false);
      const current = browser;
      const ended = new AbortController();
      const abort = () => ended.abort();
      const requireBrowser = () => {
        if (ended.signal.aborted || !current.pid || current.exitCode !== null || current.signalCode !== null) {
          throw failed('chromium', 'process-exited', { exitCode: current.exitCode, signal: current.signalCode });
        }
      };
      current.once('exit', abort);
      current.once('error', abort);
      try {
        await waitUntil(async () => {
          requireBrowser();
          try {
            const { stdout } = await runCommand('chromium', 'xwininfo', ['-root', '-tree'], until, ended.signal);
            requireBrowser();
            return /chromium/i.test(stdout);
          } catch {
            requireBrowser();
            return false;
          }
        }, 'chromium', until);
        requireBrowser();
        browserReady = true;
      } finally {
        current.off('exit', abort);
        current.off('error', abort);
      }
    })().catch(error => {
      if (browser && children.has(browser)) {
        try { process.kill(-browser.pid, 'SIGKILL'); } catch {}
      }
      throw error;
    }).finally(() => { browserStarting = undefined; });
    return browserStarting;
  }

  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  const startupTimer = setTimeout(() => { void stop(stage, { reason: 'timeout' }); }, timeout);
  try {
    await Promise.all([privateDirectory(runtime), privateDirectory(config)]);
    await Promise.all([rm(controlPath, { force: true }), rm(vncPath, { force: true })]);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(controlPath, resolve);
    });
    await chmod(controlPath, 0o600);
    await writeFile(authority, '', { mode: 0o600 });
    env = { ...process.env, XAUTHORITY: authority, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: config };
    const displayCookie = randomBytes(16).toString('hex');
    stage = 'xauth';
    await runCommand(stage, 'xauth', ['-f', authority, 'add', ':1', 'MIT-MAGIC-COOKIE-1', displayCookie], deadline);
    env.DISPLAY = ':1';
    stage = 'xvnc';
    launch('xvnc', '/usr/bin/Xtigervnc', [
      ':1', '-geometry', '1280x800', '-depth', '24', '-nolisten', 'tcp',
      '-auth', authority, '-rfbport', '-1', '-rfbunixpath', vncPath,
      '-rfbunixmode', '0600', '-SecurityTypes', 'None',
      '-AlwaysShared', '-AcceptSetDesktopSize=0', '-noreset',
    ]);
    await waitUntil(async () => {
      try {
        await runCommand('xvnc', 'xdpyinfo', [], deadline);
        return (await lstat(vncPath)).isSocket();
      } catch { return false; }
    }, 'xvnc', deadline);
    stage = 'dbus';
    const dbus = launch('dbus', 'dbus-daemon', ['--session', '--nofork', '--print-address=1']);
    await waitUntil(async () => {
      const address = logs.get('dbus').split('\n')[0];
      if (!address.startsWith('unix:')) return false;
      env.DBUS_SESSION_BUS_ADDRESS = address;
      return true;
    }, 'dbus', deadline);
    if (dbus.exitCode !== null) throw new Error('dbus');
    stage = 'settings';
    await runCommand(stage, 'xfconf-query', [
      '--channel', 'xfce4-session', '--property', '/startup/ssh-agent/enabled',
      '--create', '--type', 'bool', '--set', 'false',
    ], deadline);
    stage = 'xfce';
    launch('xfce', 'xfce4-session', []);
    stage = 'chromium';
    await ensureBrowser(deadline);
    if (!stopping) state = 'ready';
  } catch (error) {
    await stop(stage, error.details ?? { reason: 'startup-failed' });
  } finally {
    clearTimeout(startupTimer);
  }
}

try {
  if (uid === 0 || userInfo().username !== 'node') throw new Error('DesktopRequiresNodeUser');
  await privateDirectory(root);
  const [command, generation, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('DesktopInvalidArguments');
  if (command === 'ensure' && !generation) {
    const child = spawn('flock', [
      '--exclusive', '--wait', '100', '--close', join(root, 'ensure.lock'),
      process.execPath, script, '_ensure',
    ], { stdio: 'inherit' });
    child.on('error', () => { process.exitCode = 1; });
    const [code] = await once(child, 'exit');
    process.exitCode = code ?? 1;
  } else if (command === 'connect') {
    await connect(generation);
  } else if (command === '_ensure' && !generation) {
    await ensureLocked();
  } else if (command === '_supervise' && !generation) {
    await supervise();
  } else {
    throw new Error('DesktopInvalidArguments');
  }
} catch (error) {
  const message = /^Desktop[A-Za-z]+(?::[a-z]+)?$/.test(error.message) ? error.message : 'DesktopUnavailable';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { OperationError } from './microvms.ts';
import type { PreparedSessionSsh } from './session-ssh.ts';
import { argumentQuote } from './ssh.ts';
import clientAsset from './desktop-assets/client.js.asset' with { type: 'file' };
import htmlAsset from './desktop-assets/index.html.asset' with { type: 'file' };
import styleAsset from './desktop-assets/style.css.asset' with { type: 'file' };
import licensesAsset from './desktop-assets/licenses.txt.asset' with { type: 'file' };

type DesktopInfo = { protocol: 1; generation: string; width: 1280; height: 800 };
type BridgeState = { input?(message: string | Buffer): void; drain?(): void; close?(): void };
type OwnedChild = { process: Subprocess<'pipe', 'pipe', 'pipe'>; diagnostic: Promise<string>; done: Promise<number | null>; stop(): Promise<void> };
const maxFrame = 1_048_576;
const maxBuffer = 4_194_304;
const maxConnections = 4;

function aborted() { return new OperationError('DesktopAborted', 'Desktop setup was interrupted.'); }

function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function ownSsh(connection: PreparedSessionSsh, command: string[], children: Set<OwnedChild>): OwnedChild {
  let processChild: OwnedChild['process'];
  try {
    processChild = Bun.spawn(['ssh',
      '-T', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
      '-F', connection.config, connection.alias, command.map(argumentQuote).join(' '),
    ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true });
  } catch {
    throw new OperationError('DesktopSshUnavailable', 'Could not start local SSH. Install OpenSSH and retry.');
  }
  const kill = (signal: NodeJS.Signals) => {
    if (processChild.pid) { try { process.kill(-processChild.pid, signal); } catch {} }
  };
  const done = processChild.exited.then(code => { kill('SIGKILL'); return code; }, () => null);
  const diagnostic = (async () => {
    const reader = processChild.stderr.getReader();
    let tail = Buffer.alloc(0);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        tail = Buffer.concat([tail, value.subarray(-4096)]).subarray(-4096);
      }
      return tail.toString('utf8');
    } catch { return ''; } finally { reader.releaseLock(); }
  })();
  let stopping: Promise<void> | undefined;
  const owned: OwnedChild = {
    process: processChild, diagnostic, done,
    stop() {
      stopping ??= (async () => {
        kill('SIGTERM');
        try { void Promise.resolve(processChild.stdin.end()).catch(() => {}); } catch {}
        const timer = setTimeout(() => kill('SIGKILL'), 500);
        try { await done; } finally { clearTimeout(timer); }
      })();
      return stopping;
    },
  };
  children.add(owned);
  void done.then(() => children.delete(owned));
  return owned;
}

async function ensureDesktop(connection: PreparedSessionSsh, children: Set<OwnedChild>, signal: AbortSignal): Promise<DesktopInfo> {
  signal.throwIfAborted();
  const owned = ownSsh(connection, ['/usr/local/bin/mvm-desktop', 'ensure'], children);
  await owned.process.stdin.end();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let oversized = false;
  const read = (async () => {
    const reader = owned.process.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) { oversized = true; void owned.stop(); break; }
      chunks.push(value);
    }
    await reader.cancel();
  })();
  const [code, , diagnostic] = await cancellable(Promise.all([owned.done, read, owned.diagnostic]), signal);
  const output = Buffer.concat(chunks).toString('utf8');
  if (oversized) throw new OperationError('InvalidDesktopResponse', 'The VM returned an oversized desktop response.');
  if (code === 127) throw new OperationError('DesktopNotInstalled', 'This VM image does not include a desktop. Create a new session from an image with desktop support.');
  if (code !== 0) {
    const reason = diagnostic.match(/^DesktopStart(?:Failed(?::(?:xauth|xvnc|dbus|settings|xfce|chromium|desktop))?|Timeout)\r?$/m)?.[0].trim();
    throw new OperationError('DesktopStartupFailed', `Could not prepare the VM desktop.${reason ? ` VM reported ${reason}.` : ''} Run mvm session ssh NAME -- mvm-desktop ensure to inspect its error.`);
  }
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new OperationError('InvalidDesktopResponse', 'The VM did not return valid desktop readiness data.'); }
  if (!value || typeof value !== 'object' || !('protocol' in value) || value.protocol !== 1 ||
    !('generation' in value) || typeof value.generation !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.generation) ||
    !('width' in value) || value.width !== 1280 || !('height' in value) || value.height !== 800) {
    throw new OperationError('InvalidDesktopResponse', 'The VM returned unsupported desktop readiness data.');
  }
  return value as DesktopInfo;
}

function authenticated(request: Request, host: string, capability: string) {
  if (request.method !== 'GET' || request.url !== `http://${host}/desktop` ||
    request.headers.get('host') !== host || request.headers.get('origin') !== `http://${host}`) return false;
  const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim());
  if (protocols?.length !== 2 || !protocols.includes('mvm-desktop')) return false;
  const supplied = protocols.find(value => value.startsWith('mvm-desktop.auth.'))?.slice('mvm-desktop.auth.'.length);
  return !!supplied && /^[A-Za-z0-9_-]{43}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(capability));
}

function bridge(
  socket: ServerWebSocket<BridgeState>, connection: PreparedSessionSsh, info: DesktopInfo, children: Set<OwnedChild>,
) {
  const owned = ownSsh(connection, ['/usr/local/bin/mvm-desktop', 'connect', info.generation], children);
  const command = owned.process;
  const reader = command.stdout.getReader();
  const input: Buffer[] = [];
  let inputBytes = 0;
  let writing = false;
  let closed = false;
  let drained: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const setupTimer = setTimeout(() => stop(1011, 'Desktop connection timed out.'), 30_000);
  const stop = (code = 1000, reason = 'Desktop connection closed.') => {
    if (closed) return;
    closed = true;
    clearTimeout(setupTimer);
    input.length = 0;
    drained?.();
    void reader.cancel().catch(() => {});
    closeTimer = setTimeout(() => socket.terminate(), 500);
    socket.close(code, reason);
    void owned.stop();
  };
  const writeInput = async () => {
    if (writing) return;
    writing = true;
    try {
      while (!closed && input.length) {
        const chunk = input[0];
        await command.stdin.write(chunk);
        await command.stdin.flush();
        input.shift();
        inputBytes -= chunk.byteLength;
      }
    } catch { stop(1011, 'Desktop connection ended.'); }
    finally { writing = false; }
  };
  socket.data.input = message => {
    if (closed) return;
    if (typeof message === 'string') { stop(1003, 'Binary desktop messages are required.'); return; }
    if (inputBytes + message.byteLength > maxBuffer) {
      stop(1009, 'Desktop input exceeded its buffer limit.');
      return;
    }
    input.push(message);
    inputBytes += message.byteLength;
    void writeInput();
  };
  socket.data.drain = () => { drained?.(); drained = undefined; };
  socket.data.close = () => { stop(); clearTimeout(closeTimer); };
  void (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        clearTimeout(setupTimer);
        if (socket.getBufferedAmount() + value.byteLength > maxBuffer) { stop(1009, 'Desktop output exceeded its buffer limit.'); break; }
        const sent = socket.sendBinary(value);
        if (sent === 0) break;
        if (sent < 0) await new Promise<void>(resolve => { drained = resolve; });
      }
    } catch {}
    stop(1011, 'Desktop connection ended.');
  })();
  void owned.done.then(() => stop(1011, 'Desktop connection ended.'));
}

async function openBrowser(url: string, signal: AbortSignal) {
  const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  const abort = () => { opener.kill('SIGKILL'); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    const code = await cancellable(new Promise<number | null>(resolve => {
      opener.once('error', () => resolve(null));
      opener.once('close', resolve);
    }), signal);
    if (code !== 0) throw new OperationError('DesktopBrowserFailed', 'Could not open the browser. Retry with --no-open and open its URL manually.');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    opener.kill('SIGKILL');
  }
}

export async function sessionDesktop(
  connection: PreparedSessionSsh,
  options: { open: boolean; port: number },
  signal: AbortSignal,
  prepared: () => void,
): Promise<number> {
  if (process.platform === 'win32') throw new OperationError('UnsupportedPlatform', 'Desktop currently requires macOS or Linux with OpenSSH.');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new OperationError('InvalidDesktopPort', 'The desktop port must be an integer from 0 to 65535.');
  }
  const children = new Set<OwnedChild>();
  const sockets = new Set<ServerWebSocket<BridgeState>>();
  let server: Server<BridgeState> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const info = await ensureDesktop(connection, children, signal);
    const assetPaths = [
      ['/', htmlAsset, 'text/html; charset=utf-8'], ['/client.js', clientAsset, 'text/javascript; charset=utf-8'],
      ['/style.css', styleAsset, 'text/css; charset=utf-8'], ['/licenses.txt', licensesAsset, 'text/plain; charset=utf-8'],
    ] as const;
    const assets = new Map(await Promise.all(assetPaths.map(async ([path, asset, type]) =>
      [path, { body: Buffer.from(await Bun.file(asset).arrayBuffer()), type }] as const)));
    signal.throwIfAborted();
    const capability = randomBytes(32).toString('base64url');
    let host = '';
    try {
      server = Bun.serve<BridgeState>({
        hostname: '127.0.0.1', port: options.port, development: false, idleTimeout: 10, maxRequestBodySize: 0,
        fetch(request, listener) {
          const headers = {
            'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ws://${host}; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
            'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
          };
          if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            if (signal.aborted || !authenticated(request, host, capability)) return new Response(null, { status: 403, headers });
            if (sockets.size >= maxConnections) return new Response(null, { status: 429, headers });
            if (listener.upgrade(request, { data: {}, headers: { 'Sec-WebSocket-Protocol': 'mvm-desktop' } })) return;
            return new Response(null, { status: 400, headers });
          }
          if (request.headers.get('host') !== host) return new Response(null, { status: 403, headers });
          if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers });
          const path = request.url.slice(`http://${host}`.length);
          const asset = assets.get(path as typeof assetPaths[number][0]);
          if (!asset) return new Response(null, { status: 404, headers });
          return new Response(request.method === 'HEAD' ? null : asset.body, {
            headers: { ...headers, 'Content-Type': asset.type, 'Content-Length': String(asset.body.byteLength) },
          });
        },
        websocket: {
          maxPayloadLength: maxFrame, backpressureLimit: maxBuffer, closeOnBackpressureLimit: true,
          perMessageDeflate: false, idleTimeout: 120, sendPings: true,
          open(socket) {
            sockets.add(socket);
            try { bridge(socket, connection, info, children); }
            catch { socket.close(1011, 'Could not start the desktop connection.'); }
          },
          message(socket, message) { socket.data.input?.(message); },
          drain(socket) { socket.data.drain?.(); },
          close(socket) { sockets.delete(socket); socket.data.close?.(); },
        },
      });
    } catch {
      throw new OperationError('DesktopListenFailed', 'Could not listen on the requested loopback port. Use --port 0 to select an available port.');
    }
    host = `127.0.0.1:${server.port}`;
    signal.throwIfAborted();
    prepared();
    const url = `http://${host}/#token=${capability}`;
    if (options.open) await openBrowser(url, signal);
    else {
      await cancellable(new Promise<void>((resolve, reject) => {
        process.stdout.write(url + '\n', error => error ? reject(error) : resolve());
      }), signal);
    }
    await cancellable(new Promise<void>((resolve, reject) => {
      process.stderr.write('Desktop connection is active. Press Ctrl+C to disconnect; the VM stays running.\n', error => error ? reject(error) : resolve());
    }), signal);
    await new Promise<void>(resolve => {
      abortListener = () => resolve();
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) resolve();
    });
    return 0;
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    for (const socket of sockets) socket.terminate();
    await server?.stop(true);
    await Promise.allSettled([...children].map(owned => owned.stop()));
  }
}

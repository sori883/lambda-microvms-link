import { Duplex } from 'node:stream';
import { once } from 'node:events';
import WebSocket from 'ws';
import { OperationError } from './microvms.ts';

export type ShellAccess = { url: URL; token: string };

export class ManagedShell extends Duplex {
  private constructor(private readonly socket: WebSocket, signal: AbortSignal) {
    super({ highWaterMark: 64 * 1024 });
    const abort = () => this.destroy(new OperationError('Aborted', 'Shell connection aborted.'));
    signal.addEventListener('abort', abort, { once: true });
    this.once('close', () => signal.removeEventListener('abort', abort));
    this.on('error', () => {});
    socket.on('message', (data, binary) => {
      if (!binary) {
        try {
          const control: unknown = JSON.parse(data.toString());
          if (typeof control !== 'object' || control === null || !('type' in control) || control.type !== 'session_init') throw new Error();
        } catch {
          this.destroy(new OperationError('ShellProtocolError', 'Unexpected shell control message.'));
        }
        return;
      }
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (!this.push(bytes)) socket.pause();
    });
    socket.on('error', () => this.destroy(new OperationError('ShellConnectionFailed', 'WebSocket connection failed. Check shell ingress and permissions.')));
    socket.on('close', code => {
      if (code === 1000) this.push(null);
      else this.destroy(new OperationError('ShellDisconnected', 'The shell connection was interrupted. Remote work may still be running.'));
    });
    if (signal.aborted) abort();
  }

  static async connect(access: ShellAccess, signal: AbortSignal): Promise<ManagedShell> {
    if (signal.aborted) throw new OperationError('Aborted', 'Shell connection aborted.');
    const socket = new WebSocket(access.url, [
      'lambda-microvms', `lambda-microvms.authentication.${access.token}`, 'lambda-microvms.port.8022',
    ], { handshakeTimeout: 15_000, followRedirects: false, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
    const shell = new ManagedShell(socket, signal);
    try {
      await Promise.race([once(socket, 'open'), once(shell, 'error').then(([error]) => Promise.reject(error))]);
      return shell;
    } catch {
      shell.destroy();
      throw new OperationError('ShellConnectionFailed', 'WebSocket connection failed. Check shell ingress and permissions.');
    }
  }

  override _read() { this.socket.resume(); }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.socket.send(chunk, { binary: true }, error => callback(error ? new OperationError('ShellDisconnected', 'Shell send failed.') : undefined));
  }

  override _final(callback: (error?: Error | null) => void) {
    this.socket.close();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.socket.terminate();
    callback(error);
  }

  bootstrap(command: string, nonce: string): Promise<string> {
    const prefix = Buffer.from(`\x1eMVM_${nonce}:`);
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const cleanup = () => {
        this.pause();
        this.removeListener('data', data);
        this.removeListener('error', failed);
        this.removeListener('end', ended);
        this.removeListener('close', ended);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const ended = () => failed(new OperationError('SshBootstrapFailed', 'SSH setup ended before it was ready. Use an SSH-enabled image.'));
      const data = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const start = buffer.indexOf(prefix);
        const end = start < 0 ? -1 : buffer.indexOf(0x1f, start + prefix.length);
        if ((end >= 0 ? end : buffer.length) > 64 * 1024) {
          failed(new OperationError('SshBootstrapFailed', 'SSH setup exceeded its output limit.'));
          return;
        }
        if (end >= 0) {
          cleanup();
          const result = buffer.subarray(start + prefix.length, end).toString('utf8');
          const remainder = buffer.subarray(end + 1);
          if (remainder.length) this.unshift(remainder);
          resolve(result);
        }
      };
      this.on('data', data);
      this.once('error', failed);
      this.once('end', ended);
      this.once('close', ended);
      this.write(Buffer.from(command), error => { if (error) failed(error); });
    });
  }
}

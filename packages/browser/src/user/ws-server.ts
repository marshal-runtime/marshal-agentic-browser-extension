/**
 * A minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation) for the local bridge to the Marley
 * Chrome extension. Ported from zyg-edge/marley-browser-extension marshal-extension/src/ws-server.js (main 48cf63f);
 * the same rules: it listens on loopback only, upgrades only `path`, and only for an Origin `acceptOrigin` allows;
 * an unmasked client frame closes the connection (1002), as RFC 6455 requires. No
 * dependencies, so the bundle needs only `http` and `node:crypto` (both in the extension loader's allow-list).
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'events';
import http from 'http';
import type { Socket } from 'net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export class WsConnection extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  closed = false;
  lastSeen = Date.now();

  constructor(
    readonly socket: Socket,
    readonly origin: string,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('close', () => {
      this.finish();
    });
    socket.on('error', () => {
      this.finish();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      this.onFrame(frame);
      if (this.closed) return;
    }
  }

  private readFrame(): Frame | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const first = buf[0] ?? 0;
    const second = buf[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    // RFC 6455 5.1: a client masks every frame; a server closes on an unmasked one (1002, protocol error).
    if ((second & 0x80) === 0) return this.fail(1002, 'unmasked client frame');
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) return this.fail(1009, 'message too big');
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) return this.fail(1009, 'message too big');
    if (buf.length < offset + 4 + length) return null;
    const mask = buf.subarray(offset, offset + 4);
    const masked = buf.subarray(offset + 4, offset + 4 + length);
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = (masked[i] ?? 0) ^ (mask[i & 3] ?? 0);
    this.buffer = buf.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  private onFrame({ fin, opcode, payload }: Frame): void {
    if (opcode === 0x8) {
      this.sendFrame(0x8, payload.subarray(0, 2));
      this.socket.end();
      this.finish();
      return;
    }
    if (opcode === 0x9) {
      this.sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      this.fragmentOpcode = opcode;
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
    } else {
      this.fail(1002, 'unknown opcode');
      return;
    }
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      this.fail(1009, 'message too big');
      return;
    }
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    if (this.fragmentOpcode === 0x1) this.emit('message', message.toString('utf8'));
  }

  private fail(code: number, reason: string): null {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.sendFrame(0x8, body);
    this.socket.end();
    this.finish();
    return null;
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text: string): void {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.fail(code, reason);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }
}

/** The `/health` answer, so a second Marshal can tell what holds the port. */
export const HEALTH_SERVICE = 'marshal-browser';

/** Starts the server; resolves once listening, rejects with the listen error (EADDRINUSE when the port is taken). */
export function startWsServer(options: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly acceptOrigin: (origin: string) => boolean;
  readonly onConnection: (connection: WsConnection) => void;
}): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const healthy = request.url === '/health';
    response.writeHead(healthy ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: healthy, service: HEALTH_SERVICE }));
  });
  server.on('upgrade', (request: http.IncomingMessage, socket: Socket) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const key = request.headers['sec-websocket-key'];
    const origin = request.headers.origin ?? '';
    if (url.pathname !== options.path || typeof key !== 'string' || !options.acceptOrigin(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    options.onConnection(new WsConnection(socket, origin));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

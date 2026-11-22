/**
 * Chrome DevTools Protocol over `--remote-debugging-pipe`: messages are JSON terminated by a NUL byte, written to the
 * child's fd 3 and read from its fd 4. No port is opened, so nothing else on the machine can attach to this browser
 * (and this extension never attaches to someone else's, such as the user's Chrome on 9222). Needs only
 * `node:child_process` streams, which the extension loader allows.
 */
import type { Readable, Writable } from 'node:stream';

export interface CdpEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export class CdpConnection {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closedReason: string | null = null;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly timeoutMs = 30_000,
  ) {
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    output.on('close', () => {
      this.fail('browser pipe closed');
    });
    input.on('error', (error: Error) => {
      this.fail(error.message);
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) {
      return Promise.reject(new CdpError(method, this.closedReason));
    }
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, `no answer within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.input.write(`${message}\0`);
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first event that matches, or null after `timeoutMs`. */
  waitForEvent(
    match: (event: CdpEvent) => boolean,
    timeoutMs: number,
  ): { readonly promise: Promise<CdpEvent | null>; readonly cancel: () => void } {
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (value: CdpEvent | null) => void = () => undefined;
    const promise = new Promise<CdpEvent | null>((resolve) => {
      settle = resolve;
      off = this.onEvent((event) => {
        if (match(event)) {
          finish(event);
        }
      });
      timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
    });
    const finish = (value: CdpEvent | null): void => {
      off();
      if (timer) clearTimeout(timer);
      settle(value);
    };
    return {
      promise,
      cancel: () => {
        finish(null);
      },
    };
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf('\0');
    while (end >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf('\0');
      let message: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new CdpError(pending.method, message.error.message ?? 'protocol error'));
        } else {
          pending.resolve(message.result ?? {});
        }
      } else if (typeof message.method === 'string') {
        const event: CdpEvent = {
          method: message.method,
          params: message.params ?? {},
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        };
        for (const listener of this.listeners) listener(event);
      }
    }
  }

  private fail(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(pending.method, reason));
      this.pending.delete(id);
    }
  }
}

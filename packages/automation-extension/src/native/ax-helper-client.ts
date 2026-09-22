/**
 * Spawns and speaks the `marshal-ax-helper` JSON Lines protocol: one request
 * object per stdin line `{id, op, ...}`, one response per stdout line
 * `{id, ok, ...}` or `{id, ok:false, error}`. Dependency-free
 * (node:child_process only, plus a manual newline-buffer instead of
 * node:readline) so it can be bundled by esbuild without a native binding,
 * and so it only touches Node builtins the runtime host allowlists.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'fs';
import path from 'node:path';

export interface AxHelperRequest {
  readonly op: string;
  readonly [key: string]: unknown;
}

export interface AxHelperResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface AxHelperClientOptions {
  /** Absolute path to the marshal-ax-helper binary; resolved by the caller (config -> dist -> build dir). */
  readonly binaryPath: string;
  /** Per-call timeout in ms; default 10000. */
  readonly callTimeoutMs?: number;
  /** Test seam: overrides node:child_process.spawn. */
  readonly spawnFn?: typeof spawn;
}

let nextId = 1;

/** Long-lived process wrapper: correlates requests/responses by id, restarts once on crash mid-call. */
export class AxHelperClient {
  private readonly binaryPath: string;
  private readonly callTimeoutMs: number;
  private readonly spawnFn: typeof spawn;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (r: AxHelperResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private disposed = false;
  private stdoutBuffer = '';

  constructor(options: AxHelperClientOptions) {
    this.binaryPath = options.binaryPath;
    this.callTimeoutMs = options.callTimeoutMs ?? 10_000;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = this.spawnFn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.onStdoutChunk(chunk);
    });
    child.on('exit', () => {
      this.onExit(child);
    });
    child.stderr.on('data', () => {
      // Helper logs (startup banner, crash traces) - not surfaced to callers; a
      // failed in-flight call already gets rejected via onExit.
    });
    this.child = child;
    return child;
  }

  /** Manual newline-delimited line reader (no node:readline): buffer chunks, split on '\n', keep the trailing partial line. */
  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) this.onLine(line);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: AxHelperResponse & { id?: number };
    try {
      parsed = JSON.parse(trimmed) as AxHelperResponse & { id?: number };
    } catch {
      return;
    }
    const id = parsed.id;
    if (typeof id !== 'number') return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  }

  private onExit(dead: ChildProcessWithoutNullStreams): void {
    if (this.child === dead) this.child = undefined;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('AX_HELPER_CRASHED: process exited while a call was pending'));
      this.pending.delete(id);
    }
  }

  async call(request: AxHelperRequest, timeoutMs?: number): Promise<AxHelperResponse> {
    if (this.disposed) throw new Error('AX_HELPER_DISPOSED: client has been disposed');
    const child = this.ensureStarted();
    const id = nextId++;
    const line = JSON.stringify({ ...request, id });
    return new Promise<AxHelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `AX_HELPER_TIMEOUT: "${request.op}" did not respond within ${String(timeoutMs ?? this.callTimeoutMs)}ms`,
          ),
        );
      }, timeoutMs ?? this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(line + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** One retry after a crash: a call whose process died mid-flight is safe to reissue against a fresh process. */
  async callWithRestart(request: AxHelperRequest, timeoutMs?: number): Promise<AxHelperResponse> {
    try {
      return await this.call(request, timeoutMs);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('AX_HELPER_CRASHED')) {
        return this.call(request, timeoutMs);
      }
      throw error;
    }
  }

  // Not `async`: this has no `await`. The try/catch replicates async's
  // throw-becomes-rejection behavior exactly (see extension.ts's `activate`
  // for the same pattern).
  dispose(): Promise<void> {
    try {
      if (this.disposed) return Promise.resolve();
      this.disposed = true;
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('AX_HELPER_DISPOSED: client has been disposed'));
        this.pending.delete(id);
      }
      const child = this.child;
      this.child = undefined;
      if (child && !child.killed) {
        child.kill();
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
}

/** `<packageRoot>/dist/native/marshal-ax-helper`, else `<packageRoot>/native/ax-helper/.build/release/marshal-ax-helper`. */
export function resolveAxHelperPath(packageRoot: string, configuredPath?: string): string {
  if (configuredPath) return configuredPath;
  const staged = path.join(packageRoot, 'dist', 'native', 'marshal-ax-helper');
  if (existsSync(staged)) return staged;
  return path.join(packageRoot, 'native', 'ax-helper', '.build', 'release', 'marshal-ax-helper');
}

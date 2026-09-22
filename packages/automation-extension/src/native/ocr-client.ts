/**
 * Long-lived JSON-Lines client for the `marshal-ocr-helper` Swift process
 * (native/ocr-helper): one line-delimited JSON request per call, correlated
 * by `id`, with restart-on-crash and a per-call timeout. Dependency-free
 * (Node `child_process` only, plus a manual newline-buffer instead of
 * `node:readline`) so it can run inside the runtime sandbox, which only
 * allowlists a fixed set of Node builtins, without bundler surprises.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'fs';
import path from 'node:path';

export interface OcrLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly confidence: number;
}

export interface OcrResult {
  readonly lines: readonly OcrLine[];
  readonly reused: number;
  readonly read: number;
  readonly tiles: { readonly changed: number; readonly total: number };
  readonly ms: number;
}

export interface CaptureResult {
  readonly path: string;
  readonly w: number;
  readonly h: number;
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
}

export interface OcrClientOptions {
  readonly helperPath: string;
  readonly timeoutMs?: number;
  readonly maxRestarts?: number;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESTARTS = 3;

export class OcrClient {
  private readonly helperPath: string;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private restarts = 0;
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private disposed = false;
  private stdoutBuffer = '';

  constructor(options: OcrClientOptions) {
    this.helperPath = options.helperPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  }

  async ocr(
    imagePath: string,
    opts?: { readonly cacheKey?: string; readonly scale?: number; readonly level?: string },
  ): Promise<OcrResult> {
    const response = await this.call({
      op: 'ocr',
      imagePath,
      cacheKey: opts?.cacheKey,
      scale: opts?.scale,
      level: opts?.level,
    });
    if ('error' in (response as Record<string, unknown>)) {
      throw new Error(`ocr helper error: ${(response as { error: string }).error}`);
    }
    return response as OcrResult;
  }

  async capture(target?: {
    readonly windowId?: number;
    readonly pid?: number;
  }): Promise<CaptureResult> {
    const response = await this.call({
      op: 'capture',
      windowId: target?.windowId,
      pid: target?.pid,
    });
    if ('error' in (response as Record<string, unknown>)) {
      throw new Error(`ocr helper error: ${(response as { error: string }).error}`);
    }
    return response as CaptureResult;
  }

  // Not `async`: this has no `await`. The try/catch replicates async's
  // throw-becomes-rejection behavior exactly (see extension.ts's `activate`
  // for the same pattern).
  dispose(): Promise<void> {
    try {
      this.disposed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('OcrClient disposed'));
      }
      this.pending.clear();
      if (this.child) {
        this.child.kill();
        this.child = null;
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    child.on('exit', () => {
      this.handleExit();
    });
    child.stderr.on('data', () => {
      // Helper diagnostics go to stderr; surfaced only via call rejection/timeout.
    });
    this.child = child;
    return child;
  }

  /** Manual newline-delimited line reader (no node:readline): buffer chunks, split on '\n', keep the trailing partial line. */
  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }

  private handleExit(): void {
    this.child = null;
    const failures = [...this.pending.values()];
    this.pending.clear();
    for (const pending of failures) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ocr helper process exited'));
    }
  }

  private async call(request: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error('OcrClient disposed');
    const child = this.ensureStarted();
    const id = String(this.nextId);
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.restart();
        reject(new Error(`ocr helper call timed out after ${String(this.timeoutMs)}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, ...request });
      child.stdin.write(payload + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // Not `async`: this has no `await`. The try/catch replicates async's
  // throw-becomes-rejection behavior exactly (see extension.ts's `activate`
  // for the same pattern).
  private restart(): Promise<void> {
    try {
      if (this.disposed) return Promise.resolve();
      if (this.restarts >= this.maxRestarts) return Promise.resolve();
      this.restarts += 1;
      if (this.child) {
        this.child.kill();
        this.child = null;
      }
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
}

/** `<packageRoot>/dist/native/marshal-ocr-helper`, else `<packageRoot>/native/ocr-helper/.build/release/marshal-ocr-helper`. */
export function resolveOcrHelperPath(packageRoot: string, configuredPath?: string): string {
  if (configuredPath) return configuredPath;
  const staged = path.join(packageRoot, 'dist', 'native', 'marshal-ocr-helper');
  if (existsSync(staged)) return staged;
  return path.join(packageRoot, 'native', 'ocr-helper', '.build', 'release', 'marshal-ocr-helper');
}

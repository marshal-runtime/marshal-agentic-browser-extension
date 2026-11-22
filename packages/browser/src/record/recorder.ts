/**
 * Session recording: the tab's screencast frames (the same ones the watch panel shows) written to a scratch folder as
 * they arrive, then turned into an MP4 by ffmpeg when the recording stops. Each frame is held on screen until the
 * next one arrived, so the video keeps the session's real timing even though Chrome only paints on change.
 *
 * ffmpeg is found, never bundled: the configured `ffmpegPath`, then MARSHAL_BROWSER_FFMPEG, then the system's, then
 * the one @marshal/hyperframes pins under ~/.marshal/hyperframes/<version>/bin. Each candidate must answer
 * `ffmpeg -version` in a subprocess. With none, a recording is refused up front as `recorder_unavailable`: a caller
 * that asked for a video never gets a run that silently has none.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jpegSize } from '../chrome/screencast.js';
import type { ScreencastHandle, Target } from '../target.js';

export interface Ffmpeg {
  readonly ffmpeg: string;
  readonly ffprobe: string | null;
  readonly encoder: 'libx264' | 'h264_videotoolbox' | 'mpeg4';
  readonly version: string;
}

export type FfmpegLookup =
  | { readonly ok: true; readonly tool: Ffmpeg }
  | { readonly ok: false; readonly reason: string };

export interface RecorderOptions {
  /** Explicit ffmpeg binary (configuration `ffmpegPath`). */
  readonly ffmpegPath?: string;
  /** Overrides for tests: environment, home directory and the system folders searched. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly systemDirs?: readonly string[];
}

export interface VideoResult {
  readonly path: string;
  readonly frames: number;
  readonly durationMs: number;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/** Thrown when no usable ffmpeg exists; the message starts with the typed code callers branch on. */
export class RecorderUnavailable extends Error {
  readonly code = 'recorder_unavailable';
  constructor(reason: string) {
    super(`recorder_unavailable: ${reason}`);
  }
}

const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
/** At most 10 frames a second are kept; a quicker frame replaces the one waiting to be written. */
const MIN_FRAME_GAP_MS = 100;
const MAX_DURATION_MS = 15 * 60_000;
const MAX_FRAMES = 9_000;
const MAX_FRAME_BYTES = 600 * 1024 * 1024;
const ENCODE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 5_000;
const RECORD_WIDTH = 1280;

/** Every candidate path, in the order they are tried. */
export function ffmpegCandidates(options: RecorderOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const out: string[] = [];
  if (options.ffmpegPath) out.push(options.ffmpegPath);
  const fromEnv = env['MARSHAL_BROWSER_FFMPEG'];
  if (fromEnv) out.push(fromEnv);
  for (const dir of options.systemDirs ?? SYSTEM_DIRS) out.push(path.join(dir, 'ffmpeg'));
  const pinned = path.join(home, '.marshal', 'hyperframes');
  if (existsSync(pinned)) {
    let versions: string[] = [];
    try {
      versions = readdirSync(pinned);
    } catch {
      versions = [];
    }
    versions
      .sort((a, b) => compareVersions(b, a))
      .forEach((version) => out.push(path.join(pinned, version, 'bin', 'ffmpeg')));
  }
  return [...new Set(out)];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.slice(-400)}` : ''}`));
        else resolve(stdout);
      },
    );
  });
}

/** Finds a working ffmpeg by asking each candidate for its version in a subprocess. */
export async function findFfmpeg(options: RecorderOptions = {}): Promise<FfmpegLookup> {
  const tried: string[] = [];
  for (const candidate of ffmpegCandidates(options)) {
    if (!existsSync(candidate)) continue;
    tried.push(candidate);
    try {
      const version = (await run(candidate, ['-hide_banner', '-version'], PROBE_TIMEOUT_MS))
        .split('\n')[0]
        ?.trim();
      const encoders = await run(candidate, ['-hide_banner', '-encoders'], PROBE_TIMEOUT_MS);
      const encoder = /\blibx264\b/.test(encoders)
        ? 'libx264'
        : /\bh264_videotoolbox\b/.test(encoders)
          ? 'h264_videotoolbox'
          : 'mpeg4';
      const probe = path.join(path.dirname(candidate), 'ffprobe');
      return {
        ok: true,
        tool: {
          ffmpeg: candidate,
          ffprobe: existsSync(probe) ? probe : null,
          encoder,
          version: version ?? 'ffmpeg',
        },
      };
    } catch {
      // not runnable: try the next one
    }
  }
  return {
    ok: false,
    reason: tried.length
      ? `no working ffmpeg (tried ${tried.join(', ')})`
      : 'no ffmpeg found (set ffmpegPath, MARSHAL_BROWSER_FFMPEG, or install ffmpeg)',
  };
}

interface Frame {
  readonly file: string;
  readonly at: number;
}

/** One recording of one target. Start with `Recorder.start`, end with `stop()` (MP4) or `abort()` (nothing kept). */
export class Recording {
  readonly id = randomUUID();
  private readonly frames: Frame[] = [];
  private pending: { data: string; at: number } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWritten = 0;
  private bytes = 0;
  private writes: Promise<void> = Promise.resolve();
  private size: { width: number; height: number } | null = null;
  private handle: ScreencastHandle | null = null;
  private ended = false;
  private readonly startedAt: number;

  constructor(
    private readonly tool: Ffmpeg,
    private readonly target: Target,
    private readonly scratch: string,
    private readonly output: string,
    private readonly children: Set<ChildProcess>,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get outputPath(): string {
    return this.output;
  }

  async begin(): Promise<void> {
    if (!this.target.screencast) {
      throw new RecorderUnavailable(`the ${this.target.backend} backend has no screencast`);
    }
    this.handle = await this.target.screencast({ maxWidth: RECORD_WIDTH }, (data) => {
      this.onFrame(data);
    });
  }

  private onFrame(data: string): void {
    if (this.ended) return;
    const at = this.now();
    if (at - this.startedAt > MAX_DURATION_MS || this.frames.length >= MAX_FRAMES) return;
    if (this.bytes > MAX_FRAME_BYTES) return;
    if (at - this.lastWritten >= MIN_FRAME_GAP_MS) {
      this.write(data, at);
      return;
    }
    // Keep the newest frame of a burst so the settled page is never lost.
    this.pending = { data, at };
    this.flushTimer ??= setTimeout(
      () => {
        this.flushTimer = null;
        const frame = this.pending;
        this.pending = null;
        if (frame && !this.ended) this.write(frame.data, frame.at);
      },
      MIN_FRAME_GAP_MS - (at - this.lastWritten),
    );
  }

  private write(data: string, at: number): void {
    this.lastWritten = at;
    this.size ??= jpegSize(data);
    const file = path.join(this.scratch, `f${String(this.frames.length).padStart(5, '0')}.jpg`);
    this.frames.push({ file, at });
    const buffer = Buffer.from(data, 'base64');
    this.bytes += buffer.length;
    this.writes = this.writes.then(() => writeFile(file, buffer));
  }

  private async endCapture(): Promise<void> {
    this.ended = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const frame = this.pending;
    this.pending = null;
    if (frame) {
      this.ended = false;
      this.write(frame.data, frame.at);
      this.ended = true;
    }
    const handle = this.handle;
    this.handle = null;
    await handle?.stop().catch(() => undefined);
  }

  /** Stops capturing and encodes the MP4. The scratch frames are removed either way. */
  async stop(): Promise<VideoResult> {
    const stoppedAt = this.now();
    await this.endCapture();
    try {
      await this.writes;
      if (this.frames.length === 0) {
        // A page that never repainted sends no frame: record what it shows now.
        const shot = await this.target.screenshot({
          format: 'jpeg',
          width: RECORD_WIDTH,
          quality: 80,
        });
        this.ended = false;
        this.write(shot.data, stoppedAt);
        this.ended = true;
        await this.writes;
      }
      const size = evenSize(this.size ?? { width: RECORD_WIDTH, height: 800 });
      const list = path.join(this.scratch, 'frames.txt');
      const lines: string[] = [];
      this.frames.forEach((frame, index) => {
        const next = this.frames[index + 1]?.at ?? Math.max(stoppedAt, frame.at + MIN_FRAME_GAP_MS);
        const seconds = Math.max(MIN_FRAME_GAP_MS, next - frame.at) / 1000;
        lines.push(`file '${frame.file}'`, `duration ${seconds.toFixed(3)}`);
      });
      // The concat demuxer ignores the last entry's duration unless the file is listed once more.
      const last = this.frames[this.frames.length - 1];
      if (last) lines.push(`file '${last.file}'`);
      await writeFile(list, `${lines.join('\n')}\n`);
      await mkdir(path.dirname(this.output), { recursive: true });
      await this.encode(list, size);
      const bytes = (await stat(this.output)).size;
      return {
        path: this.output,
        frames: this.frames.length,
        durationMs: Math.max(0, stoppedAt - this.startedAt),
        bytes,
        width: size.width,
        height: size.height,
      };
    } finally {
      await rm(this.scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Stops capturing and keeps nothing. */
  async abort(): Promise<void> {
    await this.endCapture();
    await this.writes.catch(() => undefined);
    await rm(this.scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  private encode(list: string, size: { width: number; height: number }): Promise<void> {
    const codec =
      this.tool.encoder === 'libx264'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26']
        : this.tool.encoder === 'h264_videotoolbox'
          ? ['-c:v', 'h264_videotoolbox', '-b:v', '2M']
          : ['-c:v', 'mpeg4', '-q:v', '5'];
    const filter =
      `fps=10,scale=${String(size.width)}:${String(size.height)}:force_original_aspect_ratio=decrease,` +
      `pad=${String(size.width)}:${String(size.height)}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      filter,
      ...codec,
      '-movflags',
      '+faststart',
      this.output,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.tool.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.children.add(child);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, ENCODE_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(new Error(`recorder_failed: ${error.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `recorder_failed: ffmpeg exited ${signal ?? String(code)}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`,
            ),
          );
      });
    });
  }
}

/** Finds ffmpeg once, starts and tracks recordings, and kills any encoder still running on dispose. */
export class Recorder {
  private lookup: Promise<FfmpegLookup> | null = null;
  private readonly children = new Set<ChildProcess>();
  private readonly active = new Set<Recording>();

  constructor(private readonly options: RecorderOptions = {}) {}

  /** The ffmpeg in use, or why there is none (cached after the first answer). */
  available(): Promise<FfmpegLookup> {
    this.lookup ??= findFfmpeg(this.options);
    return this.lookup;
  }

  async start(target: Target, output: string): Promise<Recording> {
    const lookup = await this.available();
    if (!lookup.ok) throw new RecorderUnavailable(lookup.reason);
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'marshal-browser-rec-'));
    const recording = new Recording(lookup.tool, target, scratch, output, this.children);
    try {
      await recording.begin();
    } catch (error) {
      await recording.abort();
      throw error;
    }
    this.active.add(recording);
    return recording;
  }

  async stop(recording: Recording): Promise<VideoResult> {
    this.active.delete(recording);
    return recording.stop();
  }

  async abort(recording: Recording): Promise<void> {
    this.active.delete(recording);
    await recording.abort();
  }

  /** Number of ffmpeg processes this recorder has running (tests check it returns to 0). */
  get runningEncoders(): number {
    return this.children.size;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active].map((recording) => recording.abort()));
    this.active.clear();
    for (const child of this.children) child.kill('SIGKILL');
    this.children.clear();
  }
}

function evenSize(size: { width: number; height: number }): { width: number; height: number } {
  const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(size.width), height: even(size.height) };
}

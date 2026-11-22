/**
 * Part E against a real Chrome and the real ffmpeg: the managed tab's screencast delivers frames and stops cleanly,
 * a session recording becomes an MP4 with frames (checked with ffprobe), a background task is cancelled through
 * browser.task.cancel and its tab closed, and no Chrome or ffmpeg process is left afterwards.
 * Skipped, with a notice, when Chrome or ffmpeg is missing.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import { ChromeLauncher, findChrome } from '../src/chrome/launcher.js';
import { ManagedTab } from '../src/chrome/tab.js';
import { findFfmpeg } from '../src/record/recorder.js';
import { el, FakeDecider } from './helpers.js';

const chrome = findChrome();
const ffmpeg = await findFfmpeg();
if (!chrome.path) console.warn(`[record.real] SKIPPED: ${chrome.reason}`);
if (!ffmpeg.ok) console.warn(`[record.real] recording tests SKIPPED: ${ffmpeg.reason}`);

const TICKER = `<!doctype html><html><head><title>Ticker</title></head><body style="font:48px sans-serif">
<p id="n">0</p><a href="/two">Next page</a>
<script>let n = 0; setInterval(() => { document.getElementById('n').textContent = String(++n); document.body.style.background = n % 2 ? '#fde' : '#def'; }, 120);</script>
</body></html>`;

let server: http.Server;
let base = '';
let artifactDir = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      request.url === '/two'
        ? '<!doctype html><title>Two</title><h1>Second page</h1>'
        : request.url === '/tall'
          ? `<!doctype html><title>Tall</title>${'<p>A long page to scroll.</p>'.repeat(400)}`
          : TICKER,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  artifactDir = await mkdtemp(path.join(os.tmpdir(), 'mb-record-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(artifactDir, { recursive: true, force: true });
});

/**
 * Processes whose command line contains `needle` and that this test started (parent is this process) or left
 * behind (re-parented to launchd/init). Other managed Chromes on the machine (another Marshal host) are not ours.
 */
function processes(needle: string): string[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length > 2)
    .filter(([, ppid]) => Number(ppid) === process.pid || Number(ppid) === 1)
    .map((parts) => parts.join(' '))
    .filter((line) => line.includes(needle));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!chrome.path)('screencast, recording and cancel (real Chrome)', () => {
  it('the tab screencasts while consumed and stops with the last consumer', async () => {
    const launcher = new ChromeLauncher();
    try {
      const tab = await ManagedTab.open(launcher, 'visitor');
      await tab.act({ kind: 'navigate', url: `${base}/` });
      const frames: { width: number; height: number }[] = [];
      const handle = await tab.screencast({ maxWidth: 640 }, (data, meta) => {
        expect(Buffer.from(data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
        frames.push({ width: meta.width, height: meta.height });
      });
      expect(tab.screencasting).toBe(true);
      await sleep(1500);
      await handle.stop();
      expect(tab.screencasting).toBe(false);
      const seen = frames.length;
      expect(seen).toBeGreaterThan(3);
      expect(frames[0]?.width).toBeLessThanOrEqual(640);
      await sleep(600);
      expect(frames.length).toBe(seen); // no frame after stop
      await tab.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);

  it.skipIf(!ffmpeg.ok)(
    'records a session to an MP4 that has frames',
    async () => {
      const service = new BrowserService(() => new FakeDecider([{ choice: 'done' }]), {
        artifactDir,
      });
      try {
        const opened = (await service.invoke('browser.session.open', { url: `${base}/` }))
          .output as Record<string, string>;
        expect(opened['ok']).toBe(true);
        const started = (
          await service.invoke('browser.session.record.start', { sessionId: opened['sessionId'] })
        ).output as Record<string, string>;
        expect(started).toMatchObject({ ok: true });
        await sleep(1500);
        await service.invoke('browser.session.act', {
          sessionId: opened['sessionId'],
          action: { kind: 'navigate', url: `${base}/two` },
        });
        await sleep(800);
        const stopped = (
          await service.invoke('browser.session.record.stop', {
            recordingId: started['recordingId'],
          })
        ).output as {
          ok: boolean;
          video: { path: string; frames: number; bytes: number; durationMs: number };
        };
        expect(stopped.ok).toBe(true);
        const video = stopped.video;
        expect(existsSync(video.path)).toBe(true);
        expect(readFileSync(video.path).subarray(4, 8).toString('latin1')).toBe('ftyp');
        expect(video.frames).toBeGreaterThan(5);
        expect(video.durationMs).toBeGreaterThan(2000);
        if (ffmpeg.ok && ffmpeg.tool.ffprobe) {
          const probe = JSON.parse(
            execFileSync(
              ffmpeg.tool.ffprobe,
              [
                '-v',
                'error',
                '-count_frames',
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=nb_read_frames,codec_name,width,height:format=duration',
                '-of',
                'json',
                video.path,
              ],
              { encoding: 'utf8' },
            ),
          ) as {
            streams: { nb_read_frames: string; codec_name: string }[];
            format: { duration: string };
          };
          expect(Number(probe.streams[0]?.nb_read_frames)).toBeGreaterThan(10);
          expect(probe.streams[0]?.codec_name).toBe('h264');
          expect(Number(probe.format.duration)).toBeGreaterThan(2);
        }
        expect(service.lifecycle.recorder.runningEncoders).toBe(0);
      } finally {
        await service.dispose();
      }
      expect(processes(`concat -safe 0`)).toEqual([]);
    },
    90_000,
  );

  it('a background task is cancelled: typed status, its tab closed, nothing left running', async () => {
    // A decider that takes 30 s to answer, so the cancel lands mid-decision.
    const decider = new FakeDecider([{ choice: 'click e1', confidence: 0.9 }]);
    const judge = decider.judge.bind(decider);
    decider.judge = async (input) => {
      const answer = judge(input);
      await sleep(30_000);
      return answer;
    };
    const service = new BrowserService(() => decider, { artifactDir });
    try {
      const started = (
        await service.invoke('browser.task', {
          goal: 'keep scrolling',
          startUrl: `${base}/`,
          wait: false,
          bounds: { steps: 50 },
        })
      ).output as Record<string, string>;
      expect(started).toMatchObject({ ok: true, status: 'running' });
      const taskId = started['taskId'];
      for (let i = 0; i < 50; i += 1) {
        const state = (await service.invoke('browser.task.get', { taskId })).output as Record<
          string,
          unknown
        >;
        if (state['phase'] === 'deciding') break;
        await sleep(200);
      }
      const running = (await service.invoke('browser.task.get', { taskId })).output as Record<
        string,
        unknown
      >;
      expect(running).toMatchObject({ ok: true, state: 'running', phase: 'deciding' });
      const actionsBefore = decider.judged.length;
      const cancelled = (await service.invoke('browser.task.cancel', { taskId })).output as Record<
        string,
        unknown
      >;
      expect(cancelled).toMatchObject({ ok: true, cancelled: true, status: 'cancelled' });
      const after = (await service.invoke('browser.task.get', { taskId })).output as {
        result: { status: string; reason: string };
      };
      expect(after.result).toMatchObject({ status: 'cancelled', reason: 'cancelled_by_caller' });
      expect(decider.judged.length).toBe(actionsBefore); // no further decision after the cancel
      const status = (await service.invoke('browser.status', {})).output as {
        openSessions: unknown[];
      };
      expect(status.openSessions).toEqual([]);
      const listed = (await service.invoke('browser.task.list', {})).output as {
        tasks: { taskId: string; status: string }[];
      };
      expect(listed.tasks.find((task) => task.taskId === taskId)?.status).toBe('cancelled');
      const again = (await service.invoke('browser.task.cancel', { taskId })).output as Record<
        string,
        unknown
      >;
      expect(again).toMatchObject({ ok: true, cancelled: false, status: 'cancelled' });
    } finally {
      await service.dispose();
    }
  }, 90_000);

  it('two tabs at once both take input (headless focus)', async () => {
    const launcher = new ChromeLauncher();
    try {
      // A smoke check of two tabs taking input at once. The hang that Emulation.setFocusEmulationEnabled fixes
      // (tab B's mouse-wheel never answered) reproduced against en.wikipedia.org pages, not this local fixture,
      // so this test does not by itself fail without the fix.
      const a = await ManagedTab.open(launcher, 'visitor');
      await a.act({ kind: 'navigate', url: `${base}/tall` });
      const b = await ManagedTab.open(launcher, 'visitor');
      await b.act({ kind: 'navigate', url: `${base}/tall` });
      const both = await Promise.all([
        a.act({ kind: 'scroll', direction: 'down' }),
        b.act({ kind: 'scroll', direction: 'down' }),
      ]);
      expect(both).toEqual([{ ok: true }, { ok: true }]);
      await a.close();
      await b.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);

  it('leaves no Chrome or ffmpeg process behind', async () => {
    // Another test file's Chrome, shutting down in parallel, can sit re-parented to launchd for a moment: wait for
    // the exits to finish (up to 10 s) instead of judging one snapshot. A real orphan stays and fails.
    const userDataDir = path.join(os.tmpdir(), 'marshal-browser-');
    let left: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      left = [...processes(`user-data-dir=${userDataDir}`), ...processes('concat -safe 0')];
      if (left.length === 0) break;
      await sleep(500);
    }
    expect(left).toEqual([]);
  }, 30_000);
});

export { el };

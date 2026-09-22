#!/usr/bin/env node
// Fake JSON-Lines AX helper for ax-helper-client.test.ts: echoes back
// deterministic responses without needing the real Swift binary or a live
// Accessibility tree.
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const request = JSON.parse(trimmed);

  if (request.op === 'hang') return; // never respond, to exercise the client's timeout path
  if (request.op === 'crash') process.exit(1);
  if (request.op === 'crashOnce') {
    if (!existsSync(request.markerPath)) {
      writeFileSync(request.markerPath, '1');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, restarted: true }) + '\n');
    return;
  }

  if (request.op === 'permissions') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, accessibility: true, screenRecording: true }) + '\n');
    return;
  }
  if (request.op === 'snapshot') {
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        ok: true,
        app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 111 },
        window: { title: 'Untitled', x: 10, y: 20, w: 600, h: 400 },
        focused: { role: 'AXTextArea', label: '', value: '' },
        text: 'hello world',
        elements: [
          { id: 'n1', role: 'AXButton', label: 'Bold', x: 1, y: 2, w: 20, h: 20, offscreen: false, enabled: true, editable: false, where: 'top-left', actions: ['AXPress'] },
        ],
        marker: 'm1',
      }) + '\n',
    );
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: `unknown op ${request.op}` }) + '\n');
});

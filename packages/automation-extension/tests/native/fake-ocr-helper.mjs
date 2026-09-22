#!/usr/bin/env node
// Fake JSON-Lines OCR helper for ocr-client.test.ts: echoes back deterministic
// responses without needing the real Swift binary or Vision framework.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const request = JSON.parse(trimmed);

  if (request.op === 'hang') {
    return; // never respond, to exercise the client's timeout path
  }
  if (request.op === 'crash') {
    process.exit(1);
  }
  if (request.op === 'ocr') {
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        lines: [{ text: 'Fake line', x: 1, y: 2, w: 30, h: 10, confidence: 0.9 }],
        reused: 0,
        read: 1,
        tiles: { changed: 1, total: 1 },
        ms: 5,
      }) + '\n',
    );
    return;
  }
  if (request.op === 'capture') {
    process.stdout.write(
      JSON.stringify({ id: request.id, path: '/tmp/fake.png', w: 800, h: 600, originX: 0, originY: 0, scale: 2 }) +
        '\n',
    );
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, error: `unknown op ${request.op}` }) + '\n');
});

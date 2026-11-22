/**
 * The plain words a watcher reads for a task ("Clicking "Travel"", "Reading the page"): built from the offer's kind and
 * element (src/engine/say.ts), carried on every trace step and phase, summarized as `doing`, and shown by the panel
 * with the engine's raw step behind Details.
 */
import { describe, expect, it } from 'vitest';
import { runTask, type TraceStep } from '../src/engine/task.js';
import { PHASE_SAY, sayOffer } from '../src/engine/say.js';
import { describeTask, TaskRegistry } from '../src/tasks.js';
import { WATCH_HTML } from '../src/watch/app.js';
import { el, FakeDecider, FakeTarget, page, saveShot } from './helpers.js';

const URL = 'https://shop.example.com/products';
const noSleep = (): Promise<void> => Promise.resolve();

describe('sayOffer: an offer as an activity', () => {
  it('names the element by its label, else by what it is', () => {
    expect(
      sayOffer({
        action: 'click e3',
        kind: 'click',
        description: '',
        element: el('e3', { label: 'Travel' }),
      }),
    ).toBe('Clicking "Travel"');
    expect(
      sayOffer({
        action: 'type e10 query',
        kind: 'type',
        description: '',
        valueName: 'query',
        element: el('e10', {
          role: 'textbox',
          tag: 'input',
          kind: 'fill',
          label: 'Search  This\nSite',
        }),
      }),
    ).toBe('Typing into "Search This Site"');
    expect(
      sayOffer({
        action: 'click e4',
        kind: 'click',
        description: '',
        element: el('e4', { role: 'link', label: '' }),
      }),
    ).toBe('Clicking a link');
    expect(
      sayOffer({
        action: 'type e5 q',
        kind: 'type',
        description: '',
        element: el('e5', { role: '', tag: 'input', kind: 'fill', label: '' }),
      }),
    ).toBe('Typing into a text box');
    expect(sayOffer({ action: 'scroll_down', kind: 'scroll_down', description: '' })).toBe(
      'Scrolling down',
    );
    expect(sayOffer({ action: 'done', kind: 'done', description: '' })).toBe(
      'Checking the goal is met',
    );
  });

  it('never shows the engine wording: no ref, no action text', () => {
    const said = sayOffer({
      action: 'click e11',
      kind: 'click',
      description: 'button "Go"',
      element: el('e11'),
    });
    expect(said).toBe('Clicking "Button e11"');
    const long = sayOffer({
      action: 'click e2',
      kind: 'click',
      description: '',
      element: el('e2', { label: 'x'.repeat(200) }),
    });
    expect(long.length).toBeLessThan(60);
  });
});

describe('the engine carries the words on every step and phase', () => {
  it('trace steps and the acting phase say what is happening', async () => {
    const target = new FakeTarget([page(URL, [el('e1', { label: 'Travel' })])]);
    const decider = new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.95 }]);
    const steps: TraceStep[] = [];
    const phases: [string, string | undefined][] = [];
    const result = await runTask(
      {
        target,
        decider,
        saveShot,
        sleep: noSleep,
        settings: {},
        onTrace: (step) => steps.push(step),
        onPhase: (phase, say) => phases.push([phase, say]),
      },
      { goal: 'open travel', startUrl: URL },
    );
    expect(result.status).toBe('done');
    expect(steps.map((step) => step.say)).toEqual([
      'Opening shop.example.com',
      'Clicking "Travel"',
      'Checking the goal is met',
    ]);
    expect(result.trace.every((step) => typeof step.say === 'string' && step.say.length > 0)).toBe(
      true,
    );
    expect(phases).toContainEqual(['acting', 'Clicking "Travel"']);
    expect(phases.find(([phase]) => phase === 'reading')).toEqual(['reading', undefined]);
  });
});

describe('describeTask: doing', () => {
  it('is the action while acting, the phase in words otherwise, and absent once finished', async () => {
    const registry = new TaskRegistry(() => 1_000);
    let finish: (output: Record<string, unknown>) => void = () => undefined;
    const entry = registry.start('goal', () => new Promise((resolve) => (finish = resolve)));
    await Promise.resolve();
    entry.phase = 'acting';
    entry.doing = 'Clicking "Travel"';
    expect(describeTask(entry, 2_000)['doing']).toBe('Clicking "Travel"');
    entry.phase = 'reading';
    expect(describeTask(entry, 2_000)['doing']).toBe('Reading the page');
    entry.phase = 'acting';
    entry.doing = null;
    expect(describeTask(entry, 2_000)['doing']).toBe(PHASE_SAY.acting);
    finish({ ok: true, status: 'done' });
    await entry.done;
    expect(describeTask(entry, 2_000)).not.toHaveProperty('doing');
  });
});

/** The panel's own step functions, taken from the page it ships. */
function panelWords(): {
  describeStep: (state: Record<string, unknown>) => string;
  endText: (status: string) => string;
  rawStep: (state: Record<string, unknown>) => string;
} {
  const start = WATCH_HTML.indexOf('function describeStep');
  const end = WATCH_HTML.indexOf('const VIEW_ONLY');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${WATCH_HTML.slice(start, end)}; return { describeStep, endText, rawStep };`,
  )() as ReturnType<typeof panelWords>;
}

describe('panel: plain words up front, raw step behind Details', () => {
  const lastStep = {
    step: 1,
    action: 'type e10 query',
    rung: 1,
    ms: 291,
    actMs: 3,
    confidence: 0.99,
    note: 'plan: 0 more (unsure after type e10 query (click e11 0.40); done_after 0.02)',
    say: 'Typing into "Search"',
  };

  it('the status line is the plain words, with no ref, rung or timing', () => {
    const { describeStep } = panelWords();
    const running = { state: 'running', phase: 'reading', doing: 'Reading the page', lastStep };
    expect(describeStep(running)).toBe('Reading the page');
    expect(describeStep({ state: 'running', lastStep })).toBe('Typing into "Search"');
    expect(describeStep({ state: 'running' })).toBe('Starting');
    for (const jargon of ['e10', 'rung', 'ms', 'conf', 'plan:'])
      expect(describeStep(running)).not.toContain(jargon);
  });

  it('Details holds the engine step as it was', () => {
    const { rawStep } = panelWords();
    const raw = rawStep({ phase: 'reading', steps: 1, elapsedMs: 4_200, lastStep });
    expect(raw).toContain(
      'Step 1 · type e10 query · rung 1 (decision) · 291 ms · act 3 ms · conf 0.99',
    );
    expect(raw).toContain('plan: 0 more');
    expect(rawStep({})).toBe('');
  });

  it('end statuses read as words', () => {
    const { endText } = panelWords();
    expect(endText('done')).toBe('Done');
    expect(endText('budget')).toBe('Ran out of time');
    expect(endText('some_new_status')).toBe('Some new status');
  });

  it('ships a Details toggle wired to the raw step', () => {
    expect(WATCH_HTML).toMatch(/<button[^>]*id="more"[^>]*aria-controls="details"/);
    expect(WATCH_HTML).toContain('<pre class="details" id="details" hidden></pre>');
  });
});

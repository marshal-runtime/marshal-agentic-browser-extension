import { describe, expect, it } from 'vitest';
import { AxAdapter } from '../../src/native/ax-adapter.js';
import type {
  AxHelperClient,
  AxHelperRequest,
  AxHelperResponse,
} from '../../src/native/ax-helper-client.js';

function fakeClient(
  handlers: Record<string, (request: AxHelperRequest) => AxHelperResponse>,
): AxHelperClient {
  const calls: AxHelperRequest[] = [];
  const client = {
    calls,
    async callWithRestart(request: AxHelperRequest): Promise<AxHelperResponse> {
      calls.push(request);
      const handler = handlers[request.op];
      if (!handler) return { ok: false, error: `no handler for ${request.op}` };
      return handler(request);
    },
  };
  return client as unknown as AxHelperClient;
}

const SNAPSHOT_RESPONSE = {
  ok: true,
  app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 111 },
  window: { title: 'Untitled', x: 10, y: 20, w: 600, h: 400 },
  focused: { role: 'AXTextArea', label: 'text area', value: 'hi' },
  text: 'hello world',
  elements: [
    {
      id: 'n1',
      role: 'AXButton',
      label: 'Bold',
      x: 1,
      y: 2,
      w: 20,
      h: 20,
      offscreen: false,
      enabled: true,
      editable: false,
      where: 'top-left',
      actions: ['AXPress'],
    },
    {
      id: 'n2',
      role: 'AXTextField',
      label: 'Name',
      value: 'Ann',
      x: 5,
      y: 6,
      w: 100,
      h: 20,
      offscreen: false,
      enabled: true,
      editable: true,
      where: 'center',
      actions: [],
    },
  ],
  marker: 'marker-1',
};

describe('AxAdapter', () => {
  it('snapshot(): maps a click element to one raw action, url uses app://<bundleId>/<window title>', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_RESPONSE });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const snapshot = await adapter.snapshot();

    expect(snapshot.url).toBe('app://com.apple.TextEdit/Untitled');
    expect(snapshot.title).toBe('Untitled');
    expect(snapshot.marker).toEqual(['marker-1']);
    expect(snapshot.focused).toMatchObject({ role: 'AXTextArea', label: 'text area', value: 'hi' });

    const bold = snapshot.actions.find((a) => a.label === 'Bold');
    expect(bold).toMatchObject({ node: 'n1', kind: 'click', role: 'AXButton', source: 'ax' });
  });

  it('snapshot(): maps an editable element to a fill action plus an "Open <label>" click variant', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_RESPONSE });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const snapshot = await adapter.snapshot();

    const fill = snapshot.actions.find((a) => a.node === 'n2' && a.kind === 'fill');
    const open = snapshot.actions.find((a) => a.node === 'n2' && a.kind === 'click');
    expect(fill).toMatchObject({ label: 'Name', value: 'Ann' });
    expect(open).toMatchObject({ label: 'Open Name' });
  });

  it('snapshot(): appends scroll_down/scroll_up/wait controls', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_RESPONSE });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const snapshot = await adapter.snapshot();
    const ids = snapshot.actions.map((a) => a.id).filter(Boolean);
    expect(ids).toEqual(['scroll_down', 'scroll_up', 'wait']);
  });

  it('act(): click issues a press request for the action node', async () => {
    const client = fakeClient({
      snapshot: () => SNAPSHOT_RESPONSE,
      press: (request) => ({ ok: true, pressedNodeId: request['nodeId'] }),
    });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const result = await adapter.act({ node: 'n1', kind: 'click', label: 'Bold' });
    expect(result.ok).toBe(true);
    expect((client as unknown as { calls: AxHelperRequest[] }).calls.at(-1)).toMatchObject({
      op: 'press',
      nodeId: 'n1',
    });
  });

  it('act(): fill issues a setValue request with the resolved text', async () => {
    const client = fakeClient({ setValue: () => ({ ok: true }) });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const result = await adapter.act({ node: 'n2', kind: 'fill', label: 'Name' }, 'Bob');
    expect(result.ok).toBe(true);
    expect((client as unknown as { calls: AxHelperRequest[] }).calls.at(-1)).toMatchObject({
      op: 'setValue',
      nodeId: 'n2',
      text: 'Bob',
    });
  });

  it('act(): fill without text is a code error, never a helper call', async () => {
    const client = fakeClient({});
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const result = await adapter.act({ node: 'n2', kind: 'fill', label: 'Name' });
    expect(result.ok).toBe(false);
    expect((client as unknown as { calls: AxHelperRequest[] }).calls).toHaveLength(0);
  });

  it('act(): a helper error comes back as { ok: false, error } rather than throwing', async () => {
    const client = fakeClient({ press: () => ({ ok: false, error: 'boom' }) });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    const result = await adapter.act({ node: 'n1', kind: 'click', label: 'Bold' });
    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('marker(): returns the raw snapshot marker wrapped in an array', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_RESPONSE });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.apple.TextEdit',
      pid: 111,
      appName: 'TextEdit',
    });
    expect(await adapter.marker?.()).toEqual(['marker-1']);
  });
});

describe('AxAdapter dangerous chrome subrole filtering', () => {
  const SNAPSHOT_WITH_CHROME_BUTTONS = {
    ok: true,
    app: { bundleId: 'com.anthropic.claude', name: 'Claude', pid: 506 },
    window: { title: 'Claude', x: 166, y: 176, w: 1200, h: 887 },
    focused: null,
    text: '',
    elements: [
      {
        id: 'n1',
        role: 'AXButton',
        label: 'close window',
        subrole: 'AXCloseButton',
        x: 20,
        y: 20,
        w: 14,
        h: 14,
        offscreen: false,
        enabled: true,
        editable: false,
        where: 'top-left',
        actions: ['AXPress'],
      },
      {
        id: 'n2',
        role: 'AXButton',
        label: 'minimize window',
        subrole: 'AXMinimizeButton',
        x: 40,
        y: 20,
        w: 14,
        h: 14,
        offscreen: false,
        enabled: true,
        editable: false,
        where: 'top-left',
        actions: ['AXPress'],
      },
      {
        id: 'n3',
        role: 'AXButton',
        label: 'zoom window',
        subrole: 'AXZoomButton',
        x: 60,
        y: 20,
        w: 14,
        h: 14,
        offscreen: false,
        enabled: true,
        editable: false,
        where: 'top-left',
        actions: ['AXPress'],
      },
      {
        id: 'n4',
        role: 'AXButton',
        label: 'New chat',
        x: 100,
        y: 200,
        w: 80,
        h: 20,
        offscreen: false,
        enabled: true,
        editable: false,
        where: 'center',
        actions: ['AXPress'],
      },
    ],
    marker: 'marker-chrome',
  };

  it('snapshot(): drops AXCloseButton/AXMinimizeButton candidates by default, keeps AXZoomButton and ordinary buttons', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_WITH_CHROME_BUTTONS });
    const adapter = new AxAdapter(client, {
      bundleId: 'com.anthropic.claude',
      pid: 506,
      appName: 'Claude',
    });
    const snapshot = await adapter.snapshot();
    const labels = snapshot.actions.map((a) => a.label);
    expect(labels).not.toContain('close window');
    expect(labels).not.toContain('minimize window');
    expect(labels).toContain('zoom window');
    expect(labels).toContain('New chat');
  });

  it('snapshot(): a goal mentioning "close" unlocks AXCloseButton but not AXMinimizeButton', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_WITH_CHROME_BUTTONS });
    const adapter = new AxAdapter(
      client,
      { bundleId: 'com.anthropic.claude', pid: 506, appName: 'Claude' },
      { goal: 'Close the Claude window' },
    );
    const snapshot = await adapter.snapshot();
    const labels = snapshot.actions.map((a) => a.label);
    expect(labels).toContain('close window');
    expect(labels).not.toContain('minimize window');
  });

  it('snapshot(): a goal mentioning "minimize" unlocks AXMinimizeButton but not AXCloseButton', async () => {
    const client = fakeClient({ snapshot: () => SNAPSHOT_WITH_CHROME_BUTTONS });
    const adapter = new AxAdapter(
      client,
      { bundleId: 'com.anthropic.claude', pid: 506, appName: 'Claude' },
      { goal: 'minimize this window please' },
    );
    const snapshot = await adapter.snapshot();
    const labels = snapshot.actions.map((a) => a.label);
    expect(labels).toContain('minimize window');
    expect(labels).not.toContain('close window');
  });
});

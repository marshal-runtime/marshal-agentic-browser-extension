import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifestPath = fileURLToPath(new URL('../runtime-extension.json', import.meta.url));

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

const AGENT_GUIDANCE_LIMITS = { purpose: 300, when: 300, recipe: 700, boundaries: 300 } as const;
const AGENT_GUIDANCE_TOTAL_LIMIT = 1_500;

describe('runtime-extension.json manifest', () => {
  it('matches the required package identity and entrypoint shape', () => {
    expect(manifest.identity).toBe('@agentic-browser/automation-extension');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.moduleFormat).toBe('commonjs-bundle-v1');
    expect(manifest.entrypoint).toBe('dist/runtime.cjs');
    // Entrypoint must be a portable relative .cjs path (agent-runtime-extensions'
    // requireRuntimeExtensionEntrypoint): no backslashes, no leading slash, no
    // '..' segments, and it must end in .cjs.
    expect(String(manifest.entrypoint)).not.toMatch(/\\|^\/|\.\./);
    expect(String(manifest.entrypoint)).toMatch(/\.cjs$/);
  });

  it('declares the @marshal/jev extension and service dependency exactly like code-review depends on github-core', () => {
    const dependencies = manifest.dependencies as { extensions: unknown[]; services: unknown[] };
    expect(dependencies.extensions).toEqual([{ id: '@marshal/jev', version: '1.0.0' }]);
    expect(dependencies.services).toEqual([
      { id: '@marshal/jev:client', version: '1.0.0', provider: '@marshal/jev' },
    ]);
  });

  it('contributes exactly the seven browser.automation.* and eight computer.automation.* capabilities', () => {
    const contributes = manifest.contributes as { capabilities: string[] };
    expect(contributes.capabilities.sort()).toEqual(
      [
        'browser.automation.run',
        'browser.automation.subgoal',
        'browser.automation.check',
        'browser.automation.observe',
        'browser.automation.finish',
        'browser.automation.get',
        'browser.automation.list',
        'computer.automation.apps',
        'computer.automation.run',
        'computer.automation.subgoal',
        'computer.automation.check',
        'computer.automation.observe',
        'computer.automation.finish',
        'computer.automation.get',
        'computer.automation.list',
      ].sort(),
    );
  });

  it('does not declare any uiApplication - the known "action id must match ^[a-zA-Z0-9_-]+$" host gotcha does not apply here', () => {
    // Capability names intentionally use dots (e.g. "browser.automation.run"),
    // which is the capability-name convention, not a uiApplication action id.
    // This extension has no ui panel and emits no uiApplication actions, so
    // the action-id regex constraint from the host is not exercised.
    expect(manifest.uiApplications).toBeUndefined();
    expect((manifest.contributes as { ui?: unknown }).ui).toBeUndefined();
  });

  it('keeps agentGuidance within the host field/total length limits', () => {
    const guidance = manifest.agentGuidance as Record<string, string>;
    for (const [key, limit] of Object.entries(AGENT_GUIDANCE_LIMITS)) {
      const value = guidance[key];
      if (value === undefined) throw new Error(`expected agentGuidance["${key}"] to be set`);
      expect(value.length).toBeLessThanOrEqual(limit);
    }
    expect(JSON.stringify(guidance).length).toBeLessThanOrEqual(AGENT_GUIDANCE_TOTAL_LIMIT);
  });

  it('declares a closed configuration schema for the seven documented options', () => {
    const schema = manifest.configuration as {
      schema: { properties: Record<string, unknown>; additionalProperties: boolean };
    };
    expect(Object.keys(schema.schema.properties).sort()).toEqual(
      [
        'axHelperPath',
        'defaultJevModel',
        'defaultPlannerModel',
        'maxStepsPerSubgoal',
        'minConfidence',
        'ocrHelperPath',
        'ocrMode',
      ].sort(),
    );
    expect(schema.schema.additionalProperties).toBe(false);
  });
});

describe('capability descriptor names', () => {
  it('are all lower-dot-case and distinct from any future uiApplication action id charset', async () => {
    const { AUTOMATION_CAPABILITY_DESCRIPTORS } = await import('../src/capabilities.js');
    for (const descriptor of AUTOMATION_CAPABILITY_DESCRIPTORS) {
      expect(descriptor.name).toMatch(/^browser\.automation\.[a-z]+$/);
      // Permission strings mirror the zyg/keyvault "marshal.tool.invoke:<name>" convention.
      expect(descriptor.permissions?.[0]?.permission).toBe(
        `marshal.tool.invoke:${descriptor.name}`,
      );
    }
  });
});

describe('capability descriptor schemas (host install contract)', () => {
  it('declares an object outputSchema with explicit properties and additionalProperties false for every capability', async () => {
    const { AUTOMATION_CAPABILITY_DESCRIPTORS } = await import('../src/capabilities.js');
    expect(AUTOMATION_CAPABILITY_DESCRIPTORS).toHaveLength(7);
    for (const descriptor of AUTOMATION_CAPABILITY_DESCRIPTORS) {
      const schema = descriptor.outputSchema as Record<string, unknown>;
      expect(schema['type'], descriptor.name).toBe('object');
      expect(schema['additionalProperties'], descriptor.name).toBe(false);
      const properties = schema['properties'] as Record<string, unknown>;
      expect(Object.keys(properties).length, descriptor.name).toBeGreaterThan(0);
    }
  });

  it('declares object inputSchemas with explicit properties and additionalProperties false', async () => {
    const { AUTOMATION_CAPABILITY_DESCRIPTORS } = await import('../src/capabilities.js');
    for (const descriptor of AUTOMATION_CAPABILITY_DESCRIPTORS) {
      const schema = descriptor.inputSchema as Record<string, unknown>;
      expect(schema['type'], descriptor.name).toBe('object');
      expect(schema['additionalProperties'], descriptor.name).toBe(false);
      expect(Object.keys(schema['properties'] as object).length, descriptor.name).toBeGreaterThan(
        0,
      );
    }
  });

  it('covers every key returned by the run handler paths', async () => {
    const { AUTOMATION_CAPABILITY_DESCRIPTORS } = await import('../src/capabilities.js');
    const run = AUTOMATION_CAPABILITY_DESCRIPTORS.find((d) => d.name === 'browser.automation.run');
    const keys = Object.keys((run?.outputSchema as { properties: object }).properties);
    for (const key of [
      'runId',
      'status',
      'result',
      'evidence',
      'plannerSessionId',
      'stats',
      'error',
      'reason',
      'hint',
    ]) {
      expect(keys).toContain(key);
    }
  });
});

describe('bundle module allow-list', () => {
  // Exactly DEFAULT_NODE_BUILTIN_MODULES from
  // @marshal/agent-runtime-extensions/dist/loader.js (the host's require()
  // allowlist for extension bundles), plus the runtime host module itself.
  // Notably absent: 'node:fs' and 'node:readline' (only bare 'fs' is
  // provided, and readline isn't provided at all) - the bundle must never
  // require either, directly or transitively.
  it('only requires host-provided builtins (node:fs and node:readline are not provided)', () => {
    const bundle = readFileSync(
      fileURLToPath(new URL('../dist/runtime.cjs', import.meta.url)),
      'utf8',
    );
    const allowed = new Set([
      'buffer',
      'events',
      'fs',
      'http',
      'https',
      'node:child_process',
      'node:crypto',
      'node:fs/promises',
      'node:os',
      'node:path',
      'node:sqlite',
      'node:url',
      'node:util',
      'os',
      'path',
      'stream',
      'tty',
      'url',
      'util',
      'zlib',
      '@agentic-browser/runtime-host',
    ]);
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(required.filter((name) => !allowed.has(name))).toEqual([]);
  });
});

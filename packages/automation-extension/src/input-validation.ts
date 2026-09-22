/**
 * Capability input validators and small output-shaping helpers, split out
 * of capabilities.ts (mechanical move, no behavior change) to keep that
 * module under the repo's 600-line-per-module limit.
 */
import { buildActionSpace } from './action-space.js';
import type { Check } from './types.js';

const OBSERVE_FIND_CONTEXT_CHARS = 200;
const OBSERVE_MAX_MATCHES_PER_TERM = 5;

export function asRecord(input: unknown, capability: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`AUTOMATION_INVALID_INPUT: ${capability} input must be an object`);
  }
  return input as Record<string, unknown>;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`AUTOMATION_INVALID_INPUT: "${field}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

export function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`AUTOMATION_INVALID_INPUT: "${field}" must be a positive integer`);
  }
  return value;
}

export function optionalValuesMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AUTOMATION_INVALID_INPUT: "values" must be an object of label -> text');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, v] of entries) {
    if (typeof v !== 'string') {
      throw new Error(`AUTOMATION_INVALID_INPUT: "values.${key}" must be a string`);
    }
  }
  return value as Record<string, string>;
}

export function asCheck(value: unknown, field = 'check'): Check {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`AUTOMATION_INVALID_INPUT: "${field}" must be an object`);
  }
  const kind = (value as Record<string, unknown>)['kind'];
  const allowed = [
    'url_matches',
    'text_visible',
    'element_present',
    'element_absent',
    'field_value',
    'all',
    'jev_noul',
  ];
  if (typeof kind !== 'string' || !allowed.includes(kind)) {
    throw new Error(
      `AUTOMATION_INVALID_INPUT: "${field}.kind" must be one of ${allowed.join(', ')}`,
    );
  }
  if (kind === 'all') {
    const checks = (value as Record<string, unknown>)['checks'];
    if (!Array.isArray(checks) || checks.length === 0) {
      throw new Error(`AUTOMATION_INVALID_INPUT: "${field}.checks" must be a non-empty array`);
    }
    return {
      kind: 'all',
      checks: checks.map((c, i) => asCheck(c, `${field}.checks[${String(i)}]`)),
    };
  }
  return value as Check;
}

export function optionalCheck(value: unknown): Check | undefined {
  return value === undefined ? undefined : asCheck(value);
}

export function elementTableLines(
  actions: Parameters<typeof buildActionSpace>[0],
): readonly string[] {
  const space = buildActionSpace(actions);
  return space.elements.map((element) => {
    const value = element.value !== undefined ? ` = ${JSON.stringify(element.value)}` : '';
    const role = element.role ?? 'element';
    return `[${element.index}] ${role} ${JSON.stringify(element.label)}${value}`;
  });
}

export function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(
      `AUTOMATION_INVALID_INPUT: "${field}" must be an array of at most ${String(maxItems)} non-empty strings`,
    );
  }
  return value as readonly string[];
}

/** Snippets of page text around the first occurrences of each term (case-insensitive). */
export function findSnippets(
  text: string,
  terms: readonly string[],
): Record<string, readonly string[]> {
  const lower = text.toLowerCase();
  const matches: Record<string, readonly string[]> = {};
  for (const term of terms) {
    const needle = term.toLowerCase();
    const snippets: string[] = [];
    let from = 0;
    while (snippets.length < OBSERVE_MAX_MATCHES_PER_TERM) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      snippets.push(
        text.slice(
          Math.max(0, at - OBSERVE_FIND_CONTEXT_CHARS),
          at + needle.length + OBSERVE_FIND_CONTEXT_CHARS,
        ),
      );
      from = at + needle.length + OBSERVE_FIND_CONTEXT_CHARS;
    }
    matches[term] = snippets;
  }
  return matches;
}

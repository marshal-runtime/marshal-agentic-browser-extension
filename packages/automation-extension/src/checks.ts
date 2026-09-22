import { buildActionSpace } from './action-space.js';
import type { JevClient, NoulAnswer } from './contracts.js';
import type { ActionSpaceElement, Check, CheckResult, PageSnapshot } from './types.js';

const JEV_NOUL_PASS_THRESHOLD = 0.8;

function findElement(
  snapshot: PageSnapshot,
  label: string,
  role: string | undefined,
): ActionSpaceElement | undefined {
  const space = buildActionSpace(snapshot.actions);
  const normalizedLabel = label.trim().toLowerCase();
  return space.elements.find((element) => {
    if (role !== undefined && element.role !== role) return false;
    return element.label.trim().toLowerCase().includes(normalizedLabel);
  });
}

export async function evaluateCheck(
  check: Check,
  snapshot: PageSnapshot,
  jevClient: JevClient,
  jevModel: string | undefined,
): Promise<CheckResult> {
  switch (check.kind) {
    case 'url_matches': {
      let matched: boolean;
      try {
        matched = new RegExp(check.pattern).test(snapshot.url);
      } catch {
        matched = snapshot.url.includes(check.pattern);
      }
      return {
        passed: matched,
        judgedBy: 'code',
        detail: matched ? undefined : `URL "${snapshot.url}" does not match "${check.pattern}"`,
      };
    }
    case 'text_visible': {
      const passed = snapshot.text.toLowerCase().includes(check.text.toLowerCase());
      return {
        passed,
        judgedBy: 'code',
        detail: passed ? undefined : `Text "${check.text}" not visible on page`,
      };
    }
    case 'element_present': {
      const element = findElement(snapshot, check.label, check.role);
      return {
        passed: element !== undefined,
        judgedBy: 'code',
        detail: element ? undefined : `No element matching label "${check.label}" is present`,
      };
    }
    case 'element_absent': {
      const element = findElement(snapshot, check.label, check.role);
      return {
        passed: element === undefined,
        judgedBy: 'code',
        detail: element ? `Element matching label "${check.label}" is still present` : undefined,
      };
    }
    case 'field_value': {
      const element = findElement(snapshot, check.label, undefined);
      if (!element) {
        return {
          passed: false,
          judgedBy: 'code',
          detail: `No field matching label "${check.label}" is present`,
        };
      }
      const value = element.value ?? '';
      if (check.equals !== undefined) {
        const passed = value === check.equals;
        return {
          passed,
          judgedBy: 'code',
          detail: passed
            ? undefined
            : `Field "${check.label}" value is "${value}", expected "${check.equals}"`,
        };
      }
      if (check.contains !== undefined) {
        const passed = value.includes(check.contains);
        return {
          passed,
          judgedBy: 'code',
          detail: passed
            ? undefined
            : `Field "${check.label}" value "${value}" does not contain "${check.contains}"`,
        };
      }
      return {
        passed: false,
        judgedBy: 'code',
        detail: 'field_value check requires "equals" or "contains"',
      };
    }
    case 'all': {
      const children = await Promise.all(
        check.checks.map((c) => evaluateCheck(c, snapshot, jevClient, jevModel)),
      );
      const passed = children.every((child) => child.passed);
      const firstFailure = children.find((child) => !child.passed);
      return {
        passed,
        judgedBy: 'code',
        children,
        ...(firstFailure?.detail === undefined ? {} : { detail: firstFailure.detail }),
      };
    }
    case 'jev_noul': {
      const result = await jevClient.ask({
        ...(jevModel === undefined ? {} : { model: jevModel }),
        state: { url: snapshot.url, title: snapshot.title, text: snapshot.text },
        questions: { verdict: { type: 'noul', instructions: check.question } },
      });
      const answer = result.answers['verdict'] as NoulAnswer | undefined;
      const noul = answer?.noul ?? 0;
      const passed = noul >= JEV_NOUL_PASS_THRESHOLD;
      return {
        passed,
        judgedBy: 'model',
        detail: passed
          ? undefined
          : `Jev noul=${noul.toFixed(2)} below threshold ${String(JEV_NOUL_PASS_THRESHOLD)} for "${check.question}"`,
      };
    }
    default: {
      const exhaustive: never = check;
      throw new Error(`AUTOMATION_UNKNOWN_CHECK_KIND: ${JSON.stringify(exhaustive)}`);
    }
  }
}

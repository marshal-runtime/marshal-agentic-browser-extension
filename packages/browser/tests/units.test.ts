import { describe, expect, it } from 'vitest';
import { createHostDecider, DecideError } from '../src/engine/decider.js';
import { linkNeedsOwner, sameSite } from '../src/engine/guards.js';
import { buildOffers, describeElement } from '../src/engine/offers.js';
import { toSnapshot } from '../src/page/to-snapshot.js';
import { parseAction } from '../src/capabilities.js';
import type { RuntimeExecResponse, RuntimeOperationExecuteRequest } from '../src/contracts.js';
import { el, page as pageOf } from './helpers.js';

describe('toSnapshot', () => {
  it("gives one eN ref per element, merges a field's rows and collects select options", () => {
    const snap = toSnapshot({
      url: 'https://a.test/',
      title: 'A',
      w: 1280,
      h: 800,
      text: 'hello',
      omittedActions: 0,
      actions: [
        {
          node: '1',
          kind: 'fill',
          role: 'textbox',
          label: 'Email',
          tag: 'input',
          type: 'email',
          value: '',
        },
        {
          node: '1',
          kind: 'click',
          role: 'textbox',
          label: 'Open Email',
          tag: 'input',
          type: 'email',
        },
        {
          node: '2',
          kind: 'fill',
          role: 'textbox',
          label: 'Password',
          tag: 'input',
          type: 'password',
          value: '(hidden)',
          secret: true,
        },
        {
          node: '3',
          kind: 'select',
          role: 'combobox',
          label: 'Size → S',
          value: 's',
          current_value: 'M',
          tag: 'select',
        },
        {
          node: '3',
          kind: 'select',
          role: 'combobox',
          label: 'Size → L',
          value: 'l',
          current_value: 'M',
          tag: 'select',
        },
        {
          node: '4',
          kind: 'click',
          role: 'link',
          label: 'Docs',
          tag: 'a',
          href: 'https://a.test/docs',
        },
        { node: '1', kind: 'submit', label: 'Press Enter in Email', id: 'submit' },
        { node: null, kind: 'scroll', label: 'Scroll down', id: 'scroll_down' },
        { node: null, kind: 'wait', label: 'Wait', id: 'wait' },
      ],
    });
    expect(snap.elements.map((element) => [element.ref, element.kind, element.label])).toEqual([
      ['e1', 'fill', 'Email'],
      ['e2', 'fill', 'Password'],
      ['e3', 'select', 'Size'],
      ['e4', 'click', 'Docs'],
    ]);
    expect(snap.elements[1]?.secret).toBe(true);
    expect(snap.elements[2]?.options).toEqual([
      { value: 's', label: 'S' },
      { value: 'l', label: 'L' },
    ]);
    expect(snap.elements[2]?.value).toBe('M');
    expect(snap.elements[3]?.href).toBe('https://a.test/docs');
    expect(snap.canScrollDown).toBe(true);
    expect(snap.canScrollUp).toBe(false);
  });
});

describe('guards', () => {
  it('sameSite accepts equal hosts, subdomains either way and allowed sites only', () => {
    expect(sameSite('shop.com', 'shop.com')).toBe(true);
    expect(sameSite('www.shop.com', 'shop.com')).toBe(true);
    expect(sameSite('shop.com', 'help.shop.com')).toBe(true);
    expect(sameSite('shop.com', 'notshop.com')).toBe(false);
    expect(sameSite('shop.com', 'docs.partner.io', ['partner.io'])).toBe(true);
    expect(sameSite('shop.com', null)).toBe(false);
  });

  it('linkNeedsOwner reads only the element tag and address', () => {
    const page = 'https://shop.com/a';
    expect(linkNeedsOwner(el('e1', { tag: 'a', href: 'https://shop.com/b' }), page)).toBe(false);
    expect(linkNeedsOwner(el('e1', { tag: 'a', href: 'https://other.com/b' }), page)).toBe(true);
    expect(
      linkNeedsOwner(el('e1', { tag: 'a', href: 'https://shop.com/billing/plan' }), page),
    ).toBe(true);
    expect(linkNeedsOwner(el('e1', { tag: 'a', href: 'mailto:x@shop.com' }), page)).toBe(false);
    // A button labelled "Pay now" is the model's call (needs_owner question), not a word list here.
    expect(linkNeedsOwner(el('e1', { tag: 'button', label: 'Pay now' }), page)).toBe(false);
  });

  it('a link to another host of the same site is checked by its own host labels', () => {
    // sameSite accepts a parent or child host, so from the apex every subdomain is "same site"; the host itself can
    // still be the checkout / billing / OAuth step (browser-do's exact-host rule stopped these as off-site).
    const page = 'https://shop.com/cart';
    for (const href of [
      'https://checkout.shop.com/c/1',
      'https://billing.shop.com/',
      'https://pay.shop.com/session',
      'https://oauth.shop.com/start',
      'https://secure.checkout.shop.com/',
    ]) {
      expect(linkNeedsOwner(el('e1', { tag: 'a', href }), page), href).toBe(true);
    }
    expect(linkNeedsOwner(el('e1', { tag: 'a', href: 'https://help.shop.com/faq' }), page)).toBe(
      false,
    );
    expect(
      linkNeedsOwner(el('e1', { tag: 'a', href: 'https://shop.com/faq' }), 'https://www.shop.com/'),
    ).toBe(false);
    // Labels the two hosts share do not count: a page already on checkout.shop.com may link within it.
    expect(
      linkNeedsOwner(
        el('e1', { tag: 'a', href: 'https://www.checkout.shop.com/x' }),
        'https://checkout.shop.com/',
      ),
    ).toBe(false);
    // A host the caller named exactly is the caller's choice.
    expect(
      linkNeedsOwner(el('e1', { tag: 'a', href: 'https://billing.shop.com/' }), page, [
        'billing.shop.com',
      ]),
    ).toBe(false);
  });
});

describe('describeElement', () => {
  it("never prints a secret field's value, even when a backend did not hide it", () => {
    const described = describeElement(
      el('e1', { kind: 'fill', tag: 'input', type: 'text', secret: true, value: 'hunter2' }),
    );
    expect(described).not.toContain('hunter2');
  });

  it('names a caller value a field holds instead of printing it, in every offer that reaches the model', () => {
    const values = { email: 'owner@example.com', query: 'private-term' };
    const field = el('e1', {
      kind: 'fill',
      tag: 'input',
      type: 'email',
      value: 'owner@example.com',
    });
    expect(describeElement(field, values)).toContain('holds the value "email"');
    const offers = buildOffers(
      pageOf('https://shop.test/', [
        field,
        el('e2', { kind: 'fill', tag: 'input', value: 'x private-term y' }),
      ]),
      { values, lastTyped: 'e1', canGoBack: false },
    );
    const sent = offers.map((offer) => offer.description).join('\n');
    expect(sent).toContain('press Enter in');
    expect(sent).not.toContain('owner@example.com');
    expect(sent).not.toContain('private-term');
    // Text the page put there itself is still shown.
    expect(
      describeElement(el('e3', { kind: 'fill', tag: 'input', value: 'prefilled' }), values),
    ).toContain('value "prefilled"');
  });
});

describe('createHostDecider', () => {
  const ok = (output: unknown): RuntimeExecResponse => ({
    protocolVersion: '1.0.0',
    status: 'success',
    result: { output },
  });

  it("calls marshal.models.decide through the host with the caller's invocation context", async () => {
    const calls: [RuntimeOperationExecuteRequest, unknown][] = [];
    const context = { principal: { id: 'session-1', kind: 'session' } };
    const decider = createHostDecider(async (request, invocation) => {
      calls.push([request, invocation]);
      return ok({ success: true, answers: { goal_met: { type: 'predicate', probability: 0.2 } } });
    }, context);
    const out = await decider.judge({
      state: 's',
      questions: { goal_met: { type: 'predicate', instructions: 'q' } },
    });
    expect(out.answers['goal_met']).toEqual({ type: 'predicate', probability: 0.2 });
    expect(calls[0]?.[0]).toMatchObject({
      targetType: 'operation',
      target: 'marshal.models.decide',
    });
    expect(calls[0]?.[1]).toBe(context);
  });

  it('maps a missing capability and a service failure to typed errors', async () => {
    const missing = createHostDecider(async () => ({
      protocolVersion: '1.0.0',
      status: 'not_found',
    }));
    await expect(missing.judge({ state: 's', questions: {} })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      unavailable: true,
    });
    const noKey = createHostDecider(async () =>
      ok({ success: false, error: 'no key', code: 'JEV_NOT_CONNECTED' }),
    );
    await expect(noKey.judge({ state: 's', questions: {} })).rejects.toMatchObject({
      code: 'JEV_NOT_CONNECTED',
      unavailable: true,
    });
    const bad = createHostDecider(async () =>
      ok({ success: false, error: 'bad', code: 'JEV_BAD_REQUEST' }),
    );
    const error = await bad.judge({ state: 's', questions: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecideError);
    expect((error as DecideError).unavailable).toBe(false);
  });

  it('a host that fails to run decide is unavailable whatever its code, never a blocked page', async () => {
    const timedOut = createHostDecider(async () => ({
      protocolVersion: '1.0.0',
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'capability timed out' },
    }));
    await expect(timedOut.judge({ state: 's', questions: {} })).rejects.toMatchObject({
      code: 'TIMEOUT',
      unavailable: true,
    });
    const thrown = createHostDecider(async () => {
      throw new Error('host disposed');
    });
    const error = await thrown
      .extract({ state: 's', schema: {} } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecideError);
    expect((error as DecideError).unavailable).toBe(true);
  });

  it('probe makes no model call and reports a missing capability', async () => {
    const inputs: unknown[] = [];
    const present = createHostDecider(async (request) => {
      inputs.push(request.input);
      return ok({ success: false, error: 'bad', code: 'JEV_BAD_REQUEST' });
    });
    expect((await present.probe()).available).toBe(true);
    expect(inputs).toEqual([{}]);
    const missing = createHostDecider(async () => ({
      protocolVersion: '1.0.0',
      status: 'not_found',
    }));
    expect((await missing.probe()).available).toBe(false);
  });
});

describe('parseAction (browser.session.act)', () => {
  it('accepts each action kind and refuses malformed ones', () => {
    expect(parseAction({ kind: 'click', ref: 'e3' })).toEqual({ kind: 'click', ref: 'e3' });
    expect(parseAction({ kind: 'type', ref: 'e3', text: 'hi' })).toEqual({
      kind: 'type',
      ref: 'e3',
      text: 'hi',
    });
    expect(parseAction({ kind: 'scroll', direction: 'up' })).toEqual({
      kind: 'scroll',
      direction: 'up',
    });
    expect(parseAction({ kind: 'wait', ms: 99_999 })).toEqual({ kind: 'wait', ms: 10_000 });
    expect(() => parseAction({ kind: 'type', ref: 'e3' })).toThrow(/BROWSER_BAD_INPUT/);
    expect(() => parseAction({ kind: 'eval', script: 'x' })).toThrow(/BROWSER_BAD_INPUT/);
  });
});

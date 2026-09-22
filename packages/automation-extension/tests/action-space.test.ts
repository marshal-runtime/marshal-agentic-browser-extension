import { describe, expect, it } from 'vitest';
import { buildActionSpace } from '../src/action-space.js';
import type { RawSnapshotAction } from '../src/types.js';

describe('buildActionSpace', () => {
  it('builds one element per node, only offering operations for present actions', () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: '1', role: 'textbox', label: 'Email', kind: 'fill', value: '' },
      { node: '2', role: 'button', label: 'Submit', kind: 'click', value: '' },
    ];
    const space = buildActionSpace(actions);

    expect(space.elements).toHaveLength(2);
    expect(space.elements[0]).toMatchObject({
      index: '1',
      label: 'Email',
      operations: ['TYPE_TEXT'],
    });
    expect(space.elements[1]).toMatchObject({ index: '2', label: 'Submit', operations: ['CLICK'] });

    expect(Object.keys(space.targets)).toEqual(['TYPE_TEXT', 'CLICK']);
    expect(space.targets['TYPE_TEXT']?.['1']).toBe(actions[0]);
    expect(space.targets['CLICK']?.['2']).toBe(actions[1]);
    // No SELECT candidates exist, so no SELECT question should ever be built for this page.
    expect(space.targets['SELECT']).toBeUndefined();
  });

  it('groups an editable combobox into fill + click ("open") for the same node, and folds SELECT options into one element', () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: '3', role: 'textbox', label: 'City', kind: 'fill', value: 'Ber' },
      { node: '3', role: 'textbox', label: 'Open City', kind: 'click', value: 'Ber' },
      {
        node: '4',
        role: 'combobox',
        label: 'Country → Germany',
        kind: 'select',
        value: 'DE',
        current_value: '',
      },
      {
        node: '4',
        role: 'combobox',
        label: 'Country → France',
        kind: 'select',
        value: 'FR',
        current_value: '',
      },
    ];
    const space = buildActionSpace(actions);

    expect(space.elements).toHaveLength(2);
    const city = space.elements.find((e) => e.node === '3');
    expect([...(city?.operations ?? [])].sort()).toEqual(['CLICK', 'TYPE_TEXT']);

    const country = space.elements.find((e) => e.node === '4');
    if (!country) throw new Error('expected a "country" element in the action space');
    expect(country.label).toBe('Country');
    expect(country.options).toHaveLength(2);
    const [option0, option1] = country.options ?? [];
    if (!option0 || !option1) throw new Error('expected two "country" options');
    expect(space.targets['SELECT']?.[option0.index]).toBe(actions[2]);
    expect(space.targets['SELECT']?.[option1.index]).toBe(actions[3]);
  });

  it('passes where/box/near/offscreen/source through to the target candidate unchanged', () => {
    const actions: readonly RawSnapshotAction[] = [
      {
        node: '5',
        role: 'button',
        label: 'Add to cart',
        kind: 'click',
        value: '',
        where: 'below',
        box: [10, 900, 80, 24],
        near: 'Wireless Mouse',
        offscreen: true,
        source: 'dom',
      },
    ];
    const space = buildActionSpace(actions);

    expect(space.targets['CLICK']?.['1']).toMatchObject({
      where: 'below',
      box: [10, 900, 80, 24],
      near: 'Wireless Mouse',
      offscreen: true,
      source: 'dom',
    });
  });

  it('treats scroll/wait rows as non-targeted controls keyed by their upper-cased id', () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: null, kind: 'scroll', label: 'Scroll down', delta: 560, id: 'scroll_down' },
      { node: null, kind: 'wait', label: 'Wait for the page to update', id: 'wait' },
    ];
    const space = buildActionSpace(actions);

    expect(space.elements).toHaveLength(0);
    expect(Object.keys(space.controls).sort()).toEqual(['SCROLL_DOWN', 'WAIT']);
    expect(space.controls['WAIT']).toBe(actions[1]);
  });
});

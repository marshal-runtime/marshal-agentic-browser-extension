/**
 * TypeScript port of jev-ultrafast's `action_space()`
 * (/tmp/jev-ultrafast/jev_ultrafast/model.py:48-78, MIT - see README.md).
 * One index per observed element; each operation (CLICK/TYPE_TEXT/SELECT)
 * has its own valid target choices, so a bad answer to an unused target
 * question can never cause an action.
 */
import type { ActionSpace, ActionSpaceElement, RawSnapshotAction } from './types.js';

const OPERATION_BY_KIND: Readonly<Record<string, 'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SUBMIT'>> = {
  click: 'CLICK',
  fill: 'TYPE_TEXT',
  select: 'SELECT',
  submit: 'SUBMIT',
};

export function buildActionSpace(actions: readonly RawSnapshotAction[]): ActionSpace {
  const elements: ActionSpaceElement[] = [];
  const indexByNode = new Map<string, string>();
  const targets: Record<string, Record<string, RawSnapshotAction>> = {};
  const controls: Record<string, RawSnapshotAction> = {};

  for (const action of actions) {
    const operation = OPERATION_BY_KIND[action.kind];
    if (!operation) {
      const id = (action.id ?? action.label).toUpperCase();
      controls[id] = action;
      continue;
    }
    const node = action.node;
    if (node === null) continue;
    let index = indexByNode.get(node);
    let element: ActionSpaceElement;
    if (index === undefined) {
      index = String(elements.length + 1);
      indexByNode.set(node, index);
      element = {
        index,
        node,
        ...(action.role === undefined ? {} : { role: action.role }),
        label: action.label.split(' → ')[0] ?? action.label,
        ...(action.checked === undefined ? {} : { checked: action.checked }),
        ...(action.selected === undefined ? {} : { selected: action.selected }),
        ...(action.expanded === undefined ? {} : { expanded: action.expanded }),
        operations: [],
        ...(operation === 'SELECT'
          ? { value: action.current_value ?? '', options: [] }
          : action.value === undefined
            ? {}
            : { value: action.value }),
      };
      elements.push(element);
    } else {
      element = elements[Number(index) - 1] as ActionSpaceElement;
    }
    const group = (targets[operation] ??= {});
    if (!element.operations.includes(operation)) {
      element = { ...element, operations: [...element.operations, operation] };
      elements[Number(index) - 1] = element;
    }
    let target = index;
    if (operation === 'SELECT') {
      const options = element.options ?? [];
      target = `${index}:${String(options.length + 1)}`;
      element = {
        ...element,
        options: [...options, { index: target, label: action.label, value: action.value ?? '' }],
      };
      elements[Number(index) - 1] = element;
    }
    group[target] = action;
  }

  return { elements, targets, controls };
}

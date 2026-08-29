/**
 * Accessibility tree extraction tool handler.
 *
 * Implements dual-strategy extraction:
 * 1. CDP strategy using {@link Accessibility.getFullAXTree} when the debugger
 *    is attached to the active tab.
 * 2. DOM-walking fallback via the content script when CDP is unavailable.
 *
 * The resulting tree is normalised (pruning noise nodes, collapsing empty
 * generic containers, deduplicating text) and rendered as a compact
 * YAML-like snapshot string optimised for LLM consumption.
 */

import type { IBrowserAdapter, AccessibilityNode } from '@agentic-browser/shared';
import { GetAccessibilityTreeParamsSchema, normalizeAriaTree, renderAriaSnapshot, extractRefMap } from '@agentic-browser/shared';
import type { AccessibilityTreeResponseData } from '@agentic-browser/shared';

/**
 * Creates an accessibility tree extraction handler bound to the given adapter.
 *
 * The returned function validates raw params with Zod, delegates to
 * the adapter's {@link IBrowserAdapter.getAccessibilityTree} method,
 * normalises the tree, and renders a compact YAML snapshot string.
 */
export function createGetAccessibilityTreeHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<AccessibilityTreeResponseData> => {
    const parsed = GetAccessibilityTreeParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid accessibility tree params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.getAccessibilityTree();

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    const rawTree = result.value;

    // Normalise: prune noise nodes, collapse generics, deduplicate text,
    // assign interactable refs
    const normalised = normalizeAriaTree(rawTree);

    // Extract ref → bounding-box map for coordinate-based interactions
    const refs = extractRefMap(normalised);

    // Render to compact YAML snapshot
    const snapshot = renderAriaSnapshot(normalised);

    return {
      snapshot,
      ...(Object.keys(refs).length > 0 ? { refs } : {}),
    };
  };
}

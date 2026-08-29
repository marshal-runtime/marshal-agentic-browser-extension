/**
 * DOM operations module for the content script.
 *
 * Provides click, type, select, hover, scroll, focus, and accessibility tree
 * operations that run directly in the content script context with full DOM access.
 * Element targeting supports CSS selectors, XPath, and text content.
 */

import type {
  ClickOptions,
  TypeOptions,
  SelectOptions,
  HoverOptions,
  ScrollOptions,
  FocusOptions,
} from '@agentic-browser/shared';
import type { CommandResponse } from '@agentic-browser/shared';

const DEFAULT_TYPE_DELAY = 50;

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

/**
 * Resolves an element from a selector string.
 *
 * Supports CSS selectors, XPath expressions (prefixed with `//` or `xpath=`),
 * and text content matching (prefixed with `text=`).
 */
function resolveElement(selector: string): Element | null {
  if (selector.startsWith('xpath=') || selector.startsWith('//')) {
    const expression = selector.startsWith('xpath=') ? selector.slice(6) : selector;
    const result = document.evaluate(
      expression,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return result.singleNodeValue as Element | null;
  }

  if (selector.startsWith('text=')) {
    const searchText = selector.slice(5);
    return findElementByText(searchText);
  }

  return document.querySelector(selector);
}

/**
 * Walks the DOM tree to find the first element whose text content matches.
 */
function findElementByText(text: string): Element | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;

  while (node) {
    const directText = getDirectTextContent(node);
    if (directText.includes(text)) {
      return node;
    }
    node = walker.nextNode() as Element | null;
  }

  return null;
}

/**
 * Returns the direct text content of an element, excluding child element text.
 */
function getDirectTextContent(element: Element): string {
  let text = '';
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
    }
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Visibility checks
// ---------------------------------------------------------------------------

/**
 * Checks whether an element is visible in the viewport.
 *
 * An element is considered hidden if it has zero dimensions, is styled with
 * `display: none`, `visibility: hidden`, or `opacity: 0`.
 */
function isElementVisible(element: Element): boolean {
  const style = globalThis.getComputedStyle(element);

  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function notFoundResponse(requestId: string, selector: string): CommandResponse {
  return {
    id: requestId,
    success: false,
    error: {
      code: 'ELEMENT_NOT_FOUND',
      message: `No element found for selector: ${selector}`,
    },
  };
}

function notVisibleResponse(requestId: string, selector: string): CommandResponse {
  return {
    id: requestId,
    success: false,
    error: {
      code: 'ELEMENT_NOT_VISIBLE',
      message: `Element is not visible: ${selector}`,
    },
  };
}

function successResponse(requestId: string, data?: unknown): CommandResponse {
  return {
    id: requestId,
    success: true,
    data,
  };
}

/**
 * Resolves an element, validates existence and visibility, and scrolls it into view.
 *
 * Returns the element on success, or a `CommandResponse` error on failure.
 */
function resolveAndValidate(
  requestId: string,
  selector: string,
): Element | CommandResponse {
  const element = resolveElement(selector);

  if (!element) {
    return notFoundResponse(requestId, selector);
  }

  if (!isElementVisible(element)) {
    return notVisibleResponse(requestId, selector);
  }

  element.scrollIntoView({ block: 'center', behavior: 'instant' });
  return element;
}

function isErrorResponse(value: Element | CommandResponse): value is CommandResponse {
  return !(value instanceof Element);
}

// ---------------------------------------------------------------------------
// Mouse event helpers
// ---------------------------------------------------------------------------

function getElementCenter(element: Element): { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect();
  return {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
}

function dispatchMouseEvent(
  element: Element,
  type: string,
  options: Partial<MouseEventInit> = {},
): void {
  const center = getElementCenter(element);
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: globalThis as unknown as Window,
    clientX: center.clientX,
    clientY: center.clientY,
    ...options,
  });
  element.dispatchEvent(event);
}

function mouseButtonValue(button?: 'left' | 'right' | 'middle'): number {
  switch (button) {
    case 'right':
      return 2;
    case 'middle':
      return 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// DOM operations
// ---------------------------------------------------------------------------

/**
 * Clicks an element by locating it, scrolling into view, and dispatching
 * mousedown, mouseup, and click events.
 *
 * When `x` and `y` are supplied instead of a selector, dispatches mouse
 * events at the given viewport coordinates using `elementFromPoint`.
 */
function click(requestId: string, options: ClickOptions): CommandResponse {
  const button = mouseButtonValue(options.button);
  const clickCount = options.clickCount ?? 1;

  if (options.x !== undefined && options.y !== undefined) {
    // Coordinate-based click
    const target = document.elementFromPoint(options.x, options.y) ?? document.body;

    for (let i = 0; i < clickCount; i++) {
      const eventInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        view: globalThis as unknown as Window,
        clientX: options.x,
        clientY: options.y,
        button,
        detail: i + 1,
      };
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('click', eventInit));
    }

    return successResponse(requestId);
  }

  if (!options.selector) {
    return {
      id: requestId,
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'Either selector or x,y coordinates are required' },
    };
  }

  const resolved = resolveAndValidate(requestId, options.selector);

  if (isErrorResponse(resolved)) {
    return resolved;
  }

  for (let i = 0; i < clickCount; i++) {
    dispatchMouseEvent(resolved, 'mousedown', { button });
    dispatchMouseEvent(resolved, 'mouseup', { button });
    dispatchMouseEvent(resolved, 'click', { button, detail: i + 1 });
  }

  return successResponse(requestId);
}

/**
 * Types text into an input element character-by-character, dispatching
 * keydown, keypress, input, and keyup events for each character.
 */
async function type(requestId: string, options: TypeOptions): Promise<CommandResponse> {
  const resolved = resolveAndValidate(requestId, options.selector);

  if (isErrorResponse(resolved)) {
    return resolved;
  }

  const element = resolved as HTMLElement;
  element.focus();

  if (options.clearFirst && isInputLike(element)) {
    (element).value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const delay = options.delay ?? DEFAULT_TYPE_DELAY;

  for (const char of options.text) {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }),
    );

    if (isInputLike(element)) {
      (element).value += char;
    }

    element.dispatchEvent(
      new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }),
    );

    element.dispatchEvent(
      new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }),
    );

    if (delay > 0) {
      await sleep(delay);
    }
  }

  return successResponse(requestId);
}

/**
 * Selects an option in a `<select>` element by value, label, or index,
 * then triggers a change event.
 */
function select(requestId: string, options: SelectOptions): CommandResponse {
  const resolved = resolveAndValidate(requestId, options.selector);

  if (isErrorResponse(resolved)) {
    return resolved;
  }

  if (!(resolved instanceof HTMLSelectElement)) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'ELEMENT_NOT_FOUND',
        message: `Element is not a <select>: ${options.selector}`,
      },
    };
  }

  const selectEl = resolved;
  let matched = false;

  if (options.index !== undefined) {
    if (options.index >= 0 && options.index < selectEl.options.length) {
      selectEl.selectedIndex = options.index;
      matched = true;
    }
  } else if (options.label !== undefined) {
    for (const opt of selectEl.options) {
      if (opt.label === options.label || opt.textContent?.trim() === options.label) {
        opt.selected = true;
        matched = true;
        break;
      }
    }
  } else if (options.values !== undefined) {
    const valueSet = new Set(options.values);
    for (const opt of selectEl.options) {
      opt.selected = valueSet.has(opt.value);
      if (opt.selected) {
        matched = true;
      }
    }
  } else if (options.value !== undefined) {
    selectEl.value = options.value;
    matched = selectEl.value === options.value;
  }

  if (!matched) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'ELEMENT_NOT_FOUND',
        message: 'No matching option found in <select>',
      },
    };
  }

  selectEl.dispatchEvent(new Event('input', { bubbles: true }));
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));

  const selected = Array.from(selectEl.selectedOptions).map((o) => o.value);
  return successResponse(requestId, selected);
}

/**
 * Hovers over an element by dispatching mouseenter and mouseover events.
 */
function hover(requestId: string, options: HoverOptions): CommandResponse {
  const resolved = resolveAndValidate(requestId, options.selector);

  if (isErrorResponse(resolved)) {
    return resolved;
  }

  dispatchMouseEvent(resolved, 'mouseenter');
  dispatchMouseEvent(resolved, 'mouseover');

  return successResponse(requestId);
}

/**
 * Scrolls to an element or a specific pixel position.
 *
 * If a selector is provided, the element is scrolled into view.
 * Otherwise, the page is scrolled to the given x/y coordinates.
 */
function scroll(requestId: string, options: ScrollOptions): CommandResponse {
  const behavior = options.behavior ?? 'auto';

  if (options.selector) {
    const element = resolveElement(options.selector);

    if (!element) {
      return notFoundResponse(requestId, options.selector);
    }

    element.scrollIntoView({ behavior, block: 'center' });
    return successResponse(requestId);
  }

  globalThis.scrollTo({
    left: options.x ?? 0,
    top: options.y ?? 0,
    behavior,
  });

  return successResponse(requestId);
}

/**
 * Focuses an element.
 */
function focus(requestId: string, options: FocusOptions): CommandResponse {
  const resolved = resolveAndValidate(requestId, options.selector);

  if (isErrorResponse(resolved)) {
    return resolved;
  }

  (resolved as HTMLElement).focus();
  return successResponse(requestId);
}

// ---------------------------------------------------------------------------
// Accessibility tree walking
// ---------------------------------------------------------------------------

/** Accessibility node shape returned by DOM-walking extraction. */
interface A11yNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  selector?: string;
  states?: string[];
  boundingBox?: { x: number; y: number; width: number; height: number };
  offScreen?: boolean;
  children?: A11yNode[];
}

/** Tag names that map to implicit ARIA roles. */
const IMPLICIT_ROLE_MAP: Readonly<Record<string, string>> = {
  A: 'link',
  ARTICLE: 'article',
  ASIDE: 'complementary',
  BUTTON: 'button',
  DIALOG: 'dialog',
  FOOTER: 'contentinfo',
  FORM: 'form',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  HEADER: 'banner',
  HR: 'separator',
  IMG: 'img',
  INPUT: 'textbox',
  LI: 'listitem',
  MAIN: 'main',
  NAV: 'navigation',
  OL: 'list',
  OPTION: 'option',
  OUTPUT: 'status',
  PROGRESS: 'progressbar',
  SECTION: 'region',
  SELECT: 'combobox',
  TABLE: 'table',
  TD: 'cell',
  TEXTAREA: 'textbox',
  TH: 'columnheader',
  TR: 'row',
  UL: 'list',
};

/** Tags that should be skipped entirely during tree walking. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

/** Interactive element tag names. */
const INTERACTIVE_TAGS = new Set([
  'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
]);

/** Returns the ARIA role of an element, preferring explicit role attribute. */
function getRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) {
    return explicit;
  }

  const tag = element.tagName;

  if (tag === 'INPUT') {
    const inputType = (element as HTMLInputElement).type;
    switch (inputType) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'range':
        return 'slider';
      case 'submit':
      case 'reset':
      case 'button':
        return 'button';
      case 'search':
        return 'searchbox';
      default:
        return 'textbox';
    }
  }

  return IMPLICIT_ROLE_MAP[tag] ?? 'generic';
}

/** Returns the accessible name of an element. */
function getAccessibleName(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return ariaLabel;
  }

  const ariaLabelledBy = element.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const parts: string[] = [];
    for (const id of ariaLabelledBy.split(/\s+/)) {
      const ref = document.getElementById(id);
      if (ref) {
        parts.push(ref.textContent?.trim() ?? '');
      }
    }
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  const tag = element.tagName;

  if (tag === 'IMG') {
    return (element as HTMLImageElement).alt ?? '';
  }

  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const inputEl = element as HTMLInputElement;
    if (inputEl.id) {
      const label = document.querySelector(`label[for="${inputEl.id}"]`);
      if (label) {
        return label.textContent?.trim() ?? '';
      }
    }
    return inputEl.placeholder ?? '';
  }

  if (tag === 'A') {
    return element.textContent?.trim() ?? '';
  }

  return getDirectTextContent(element);
}

/** Collects ARIA state attributes from an element. */
function getStates(element: Element): string[] {
  const states: string[] = [];

  if (element.getAttribute('aria-disabled') === 'true' || (element as HTMLButtonElement).disabled) {
    states.push('disabled');
  }
  if (element.getAttribute('aria-expanded') === 'true') {
    states.push('expanded');
  }
  if (element.getAttribute('aria-expanded') === 'false') {
    states.push('collapsed');
  }
  if (element.getAttribute('aria-selected') === 'true') {
    states.push('selected');
  }
  if (element.getAttribute('aria-checked') === 'true' || (element as HTMLInputElement).checked) {
    states.push('checked');
  }
  if (element.getAttribute('aria-required') === 'true' || (element as HTMLInputElement).required) {
    states.push('required');
  }
  if (element.getAttribute('aria-readonly') === 'true' || (element as HTMLInputElement).readOnly) {
    states.push('readonly');
  }
  if (element.getAttribute('aria-hidden') === 'true') {
    states.push('hidden');
  }
  if (element.getAttribute('aria-busy') === 'true') {
    states.push('busy');
  }
  if (element.hasAttribute('aria-invalid') && element.getAttribute('aria-invalid') !== 'false') {
    states.push('invalid');
  }

  return states;
}

/** Generates a unique CSS selector for an element. */
function buildSelector(element: Element): string {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  const tag = element.tagName.toLowerCase();

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
  }

  const name = element.getAttribute('name');
  if (name) {
    return `${tag}[name="${CSS.escape(name)}"]`;
  }

  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    const parentEl: Element | null = current.parentElement;
    if (parentEl) {
      const currentTag = current.tagName;
      const siblings = Array.from(parentEl.children).filter(
        (child: Element) => child.tagName === currentTag,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = parentEl;
  }

  return parts.join(' > ');
}

/** Returns the value of an interactive element. */
function getElementValue(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.checked ? 'true' : 'false';
    }
    return element.value || undefined;
  }
  if (element instanceof HTMLTextAreaElement) {
    return element.value || undefined;
  }
  if (element instanceof HTMLSelectElement) {
    return element.value || undefined;
  }
  if (element instanceof HTMLProgressElement) {
    return String(element.value);
  }

  const ariaValueNow = element.getAttribute('aria-valuenow');
  if (ariaValueNow !== null) {
    return ariaValueNow;
  }

  return undefined;
}

/** Checks whether an element contributes meaningfully to the accessibility tree. */
function isRelevantNode(element: Element, role: string): boolean {
  if (role !== 'generic') {
    return true;
  }

  if (element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby')) {
    return true;
  }

  if (INTERACTIVE_TAGS.has(element.tagName)) {
    return true;
  }

  if (element.getAttribute('tabindex') !== null) {
    return true;
  }

  return false;
}

/**
 * Walks the DOM tree and builds an accessibility tree representation.
 *
 * Traverses all child elements recursively, extracting roles, names, values,
 * states, and unique selectors for interactive elements. Handles iframes by
 * attempting to traverse their content documents when same-origin.
 */
function walkA11yTree(
  root: Element,
  maxDepth: number,
  includeIgnored: boolean,
  depth: number = 0,
  nodeCount: { value: number } = { value: 0 },
): A11yNode | null {
  if (depth > maxDepth) {
    return null;
  }

  if (SKIP_TAGS.has(root.tagName)) {
    return null;
  }

  const role = getRole(root);
  const states = getStates(root);

  if (!includeIgnored && states.includes('hidden')) {
    return null;
  }

  const isRelevant = isRelevantNode(root, role);
  const isInteractive = INTERACTIVE_TAGS.has(root.tagName) || root.getAttribute('tabindex') !== null;

  const children: A11yNode[] = [];

  if (root.tagName === 'IFRAME') {
    try {
      const iframe = root as HTMLIFrameElement;
      const iframeDoc = iframe.contentDocument;
      if (iframeDoc?.body) {
        const iframeChild = walkA11yTree(
          iframeDoc.body,
          maxDepth,
          includeIgnored,
          depth + 1,
          nodeCount,
        );
        if (iframeChild) {
          children.push(iframeChild);
        }
      }
    } catch {
      // Cross-origin iframe — skip content
    }
  } else {
    for (const child of root.children) {
      const childNode = walkA11yTree(child, maxDepth, includeIgnored, depth + 1, nodeCount);
      if (childNode) {
        children.push(childNode);
      }
    }
  }

  if (!isRelevant && children.length === 0) {
    return null;
  }

  if (!isRelevant && children.length > 0) {
    if (children.length === 1) {
      return children[0] ?? null;
    }
    return {
      role: 'group',
      name: '',
      children,
    };
  }

  nodeCount.value++;

  const node: A11yNode = {
    role,
    name: getAccessibleName(root),
  };

  const value = getElementValue(root);
  if (value !== undefined) {
    node.value = value;
  }

  const description = root.getAttribute('aria-describedby');
  if (description) {
    const descParts: string[] = [];
    for (const id of description.split(/\s+/)) {
      const ref = document.getElementById(id);
      if (ref) {
        descParts.push(ref.textContent?.trim() ?? '');
      }
    }
    if (descParts.length > 0) {
      node.description = descParts.join(' ');
    }
  }

  if (isInteractive) {
    node.selector = buildSelector(root);
  }

  // Attach bounding box (viewport-relative → page-absolute)
  const rect = root.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    node.boundingBox = {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };

    // Mark as off-screen if entirely outside the viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) {
      node.offScreen = true;
    }
  }

  if (states.length > 0) {
    node.states = states;
  }

  if (children.length > 0) {
    node.children = children;
  }

  return node;
}

/**
 * Extracts an accessibility tree from the current page DOM.
 *
 * Returns a structured tree with roles, names, values, states, and selectors.
 * The tree is optimised for performance by pruning irrelevant nodes.
 */
function getAccessibilityTree(
  requestId: string,
  options?: { maxDepth?: number; includeIgnored?: boolean },
): CommandResponse {
  const maxDepth = options?.maxDepth ?? 100;
  const includeIgnored = options?.includeIgnored ?? false;
  const nodeCount = { value: 0 };

  const root = document.body ?? document.documentElement;

  const tree = walkA11yTree(root, maxDepth, includeIgnored, 0, nodeCount);

  const result = tree ?? {
    role: 'document',
    name: document.title || '',
    children: [],
  };

  return successResponse(requestId, {
    tree: result,
    nodeCount: nodeCount.value,
  });
}

// ---------------------------------------------------------------------------
// Storage operations
// ---------------------------------------------------------------------------

function getLocalStorageItem(requestId: string, key: string): CommandResponse {
  try {
    const value = localStorage.getItem(key);
    return successResponse(requestId, { key, value });
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to read localStorage',
      },
    };
  }
}

function setLocalStorageItem(requestId: string, key: string, value: string): CommandResponse {
  try {
    localStorage.setItem(key, value);
    return successResponse(requestId);
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to write localStorage',
      },
    };
  }
}

function removeLocalStorageItem(requestId: string, key: string): CommandResponse {
  try {
    localStorage.removeItem(key);
    return successResponse(requestId);
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to remove localStorage item',
      },
    };
  }
}

function getSessionStorageItem(requestId: string, key: string): CommandResponse {
  try {
    const value = sessionStorage.getItem(key);
    return successResponse(requestId, { key, value });
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to read sessionStorage',
      },
    };
  }
}

function setSessionStorageItem(requestId: string, key: string, value: string): CommandResponse {
  try {
    sessionStorage.setItem(key, value);
    return successResponse(requestId);
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to write sessionStorage',
      },
    };
  }
}

function removeSessionStorageItem(requestId: string, key: string): CommandResponse {
  try {
    sessionStorage.removeItem(key);
    return successResponse(requestId);
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to remove sessionStorage item',
      },
    };
  }
}

function clearAllStorage(requestId: string): CommandResponse {
  try {
    localStorage.clear();
    sessionStorage.clear();
    return successResponse(requestId);
  } catch (error) {
    return {
      id: requestId,
      success: false,
      error: {
        code: 'STORAGE_ERROR',
        message: error instanceof Error ? error.message : 'Failed to clear storage',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isInputLike(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  click,
  type,
  select,
  hover,
  scroll,
  focus,
  getAccessibilityTree,
  resolveElement,
  isElementVisible,
  getLocalStorageItem,
  setLocalStorageItem,
  removeLocalStorageItem,
  getSessionStorageItem,
  setSessionStorageItem,
  removeSessionStorageItem,
  clearAllStorage,
};

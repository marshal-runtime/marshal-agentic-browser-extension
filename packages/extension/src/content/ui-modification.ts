/**
 * UI modification module for the content script.
 *
 * Provides DOM manipulation operations (text, elements, attributes) and
 * CSS operations (inline styles, classes, global stylesheets) that run
 * directly in the content script context with full DOM access.
 *
 * Tracks modification history for undo/revert support.
 */

import type { CommandResponse } from '@agentic-browser/shared';

// ---------------------------------------------------------------------------
// Modification history types & storage
// ---------------------------------------------------------------------------

interface ModificationRecord {
  readonly type: 'html' | 'css';
  readonly action: string;
  readonly selector: string;
  readonly timestamp: number;
  readonly restore: () => void;
}

const modificationHistory: ModificationRecord[] = [];

// ---------------------------------------------------------------------------
// Element resolution (reused from dom-operations pattern)
// ---------------------------------------------------------------------------

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
// Response helpers
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

function successResponse(requestId: string, data?: unknown): CommandResponse {
  return {
    id: requestId,
    success: true,
    data,
  };
}

// ---------------------------------------------------------------------------
// HTML modification operations
// ---------------------------------------------------------------------------

function modifyElementText(
  requestId: string,
  options: { selector: string; text: string },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const previousText = element.textContent;
  element.textContent = options.text;

  modificationHistory.push({
    type: 'html',
    action: 'modifyText',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      element.textContent = previousText;
    },
  });

  return successResponse(requestId);
}

function addElement(
  requestId: string,
  options: { selector: string; html: string; position: string },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const position = options.position as InsertPosition;
  const childCountBefore = element.parentElement?.childElementCount ?? 0;
  element.insertAdjacentHTML(position, options.html);
  const childCountAfter = element.parentElement?.childElementCount ?? 0;
  const addedCount = childCountAfter - childCountBefore;

  modificationHistory.push({
    type: 'html',
    action: 'addElement',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      if (position === 'beforebegin' || position === 'afterend') {
        const parent = element.parentElement;
        if (parent) {
          const idx = Array.from(parent.children).indexOf(element);
          const removeStart = position === 'beforebegin' ? idx - addedCount : idx + 1;
          for (let i = 0; i < addedCount; i++) {
            parent.children[removeStart]?.remove();
          }
        }
      } else if (position === 'afterbegin') {
        for (let i = 0; i < addedCount; i++) {
          element.firstElementChild?.remove();
        }
      } else if (position === 'beforeend') {
        for (let i = 0; i < addedCount; i++) {
          element.lastElementChild?.remove();
        }
      }
    },
  });

  return successResponse(requestId);
}

function removeElement(
  requestId: string,
  options: { selector: string },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const parent = element.parentElement;
  const nextSibling = element.nextSibling;
  const removedHtml = element.outerHTML;
  element.remove();

  modificationHistory.push({
    type: 'html',
    action: 'removeElement',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      if (parent) {
        const temp = document.createElement('template');
        temp.innerHTML = removedHtml;
        const restored = temp.content.firstElementChild;
        if (restored) {
          if (nextSibling) {
            parent.insertBefore(restored, nextSibling);
          } else {
            parent.appendChild(restored);
          }
        }
      }
    },
  });

  return successResponse(requestId);
}

function modifyAttribute(
  requestId: string,
  options: { selector: string; attribute: string; value: string | null },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const previousValue = element.getAttribute(options.attribute);

  if (options.value === null) {
    element.removeAttribute(options.attribute);
  } else {
    element.setAttribute(options.attribute, options.value);
  }

  modificationHistory.push({
    type: 'html',
    action: 'modifyAttribute',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      if (previousValue === null) {
        element.removeAttribute(options.attribute);
      } else {
        element.setAttribute(options.attribute, previousValue);
      }
    },
  });

  return successResponse(requestId);
}

// ---------------------------------------------------------------------------
// CSS modification operations
// ---------------------------------------------------------------------------

function setInlineStyle(
  requestId: string,
  options: { selector: string; styles: Record<string, string> },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const htmlEl = element as HTMLElement;
  const previousValues: Record<string, string> = {};
  for (const property of Object.keys(options.styles)) {
    previousValues[property] = htmlEl.style.getPropertyValue(property);
  }

  for (const [property, value] of Object.entries(options.styles)) {
    htmlEl.style.setProperty(property, value);
  }

  modificationHistory.push({
    type: 'css',
    action: 'setStyle',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      for (const [property, prev] of Object.entries(previousValues)) {
        if (prev) {
          htmlEl.style.setProperty(property, prev);
        } else {
          htmlEl.style.removeProperty(property);
        }
      }
    },
  });

  return successResponse(requestId);
}

function addClass(
  requestId: string,
  options: { selector: string; className: string },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const hadClass = element.classList.contains(options.className);
  element.classList.add(options.className);

  modificationHistory.push({
    type: 'css',
    action: 'addClass',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      if (!hadClass) {
        element.classList.remove(options.className);
      }
    },
  });

  return successResponse(requestId);
}

function removeClass(
  requestId: string,
  options: { selector: string; className: string },
): CommandResponse {
  const element = resolveElement(options.selector);

  if (!element) {
    return notFoundResponse(requestId, options.selector);
  }

  const hadClass = element.classList.contains(options.className);
  element.classList.remove(options.className);

  modificationHistory.push({
    type: 'css',
    action: 'removeClass',
    selector: options.selector,
    timestamp: Date.now(),
    restore: () => {
      if (hadClass) {
        element.classList.add(options.className);
      }
    },
  });

  return successResponse(requestId);
}

function injectStylesheet(
  requestId: string,
  options: { css: string },
): CommandResponse {
  const style = document.createElement('style');
  style.textContent = options.css;
  const id = `agentic-style-${Date.now()}`;
  style.setAttribute('data-agentic-id', id);
  document.head.appendChild(style);

  modificationHistory.push({
    type: 'css',
    action: 'injectStylesheet',
    selector: `[data-agentic-id="${id}"]`,
    timestamp: Date.now(),
    restore: () => {
      style.remove();
    },
  });

  return successResponse(requestId, { styleId: id });
}

// ---------------------------------------------------------------------------
// Undo / Revert operations
// ---------------------------------------------------------------------------

function undoLastModification(requestId: string, type: 'html' | 'css'): CommandResponse {
  for (let i = modificationHistory.length - 1; i >= 0; i--) {
    if (modificationHistory[i]!.type === type) {
      const record = modificationHistory.splice(i, 1)[0]!;
      record.restore();
      return successResponse(requestId, {
        undone: true,
        action: record.action,
        selector: record.selector,
      });
    }
  }

  return successResponse(requestId, { undone: false, reason: `No ${type} modifications to undo` });
}

function revertAllModifications(requestId: string, type: 'html' | 'css'): CommandResponse {
  let count = 0;

  for (let i = modificationHistory.length - 1; i >= 0; i--) {
    if (modificationHistory[i]!.type === type) {
      const record = modificationHistory.splice(i, 1)[0]!;
      record.restore();
      count++;
    }
  }

  return successResponse(requestId, { reverted: count });
}

function getModificationCount(): { html: number; css: number; total: number } {
  let html = 0;
  let css = 0;
  for (const record of modificationHistory) {
    if (record.type === 'html') html++;
    else css++;
  }
  return { html, css, total: html + css };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  modifyElementText,
  addElement,
  removeElement,
  modifyAttribute,
  setInlineStyle,
  addClass,
  removeClass,
  injectStylesheet,
  undoLastModification,
  revertAllModifications,
  getModificationCount,
};

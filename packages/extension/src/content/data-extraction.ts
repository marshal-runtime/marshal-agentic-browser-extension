/**
 * Data extraction module for the content script.
 *
 * Provides HTML retrieval and structured data extraction operations
 * that run directly in the content script context with full DOM access.
 * All functions are self-contained with no imports from extension code.
 */

import type { CommandResponse } from '@agentic-browser/shared';

// ---------------------------------------------------------------------------
// Element resolution (mirrored from dom-operations for self-containment)
// ---------------------------------------------------------------------------

/**
 * Resolves an element from a selector string.
 *
 * Supports CSS selectors and XPath expressions (prefixed with `//` or `xpath=`).
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

  return document.querySelector(selector);
}

/**
 * Resolves all elements matching a selector string.
 *
 * Supports CSS selectors and XPath expressions (prefixed with `//` or `xpath=`).
 */
function resolveElements(selector: string): Element[] {
  if (selector.startsWith('xpath=') || selector.startsWith('//')) {
    const expression = selector.startsWith('xpath=') ? selector.slice(6) : selector;
    const result = document.evaluate(
      expression,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const elements: Element[] = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      const node = result.snapshotItem(i);
      if (node instanceof Element) {
        elements.push(node);
      }
    }
    return elements;
  }

  return Array.from(document.querySelectorAll(selector));
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function successResponse(requestId: string, data?: unknown): CommandResponse {
  return {
    id: requestId,
    success: true,
    data,
  };
}

function errorResponse(requestId: string, code: string, message: string): CommandResponse {
  return {
    id: requestId,
    success: false,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// HTML retrieval
// ---------------------------------------------------------------------------

/** Returns the full page HTML (document.documentElement.outerHTML). */
function getFullHTML(requestId: string): CommandResponse {
  const html = document.documentElement.outerHTML;
  return successResponse(requestId, {
    html,
    length: html.length,
  });
}

/** Returns the outerHTML of a specific element matched by selector. */
function getElementHTML(requestId: string, selector: string): CommandResponse {
  if (!selector) {
    return getFullHTML(requestId);
  }

  const element = resolveElement(selector);

  if (!element) {
    return errorResponse(
      requestId,
      'ELEMENT_NOT_FOUND',
      `No element found for selector: ${selector}`,
    );
  }

  const html = element.outerHTML;
  return successResponse(requestId, {
    html,
    selector,
    length: html.length,
  });
}

// ---------------------------------------------------------------------------
// Table data extraction
// ---------------------------------------------------------------------------

/** Table data shape. */
interface TableResult {
  headers: string[];
  rows: string[][];
  selector?: string;
}

/** Extracts structured data from `<table>` elements. */
function extractTableData(requestId: string, selector?: string): CommandResponse {
  const tables = selector
    ? resolveElements(selector).filter((el) => el.tagName === 'TABLE')
    : Array.from(document.querySelectorAll('table'));

  const results: TableResult[] = [];

  for (const table of tables) {
    const headerCells = table.querySelectorAll('thead th, thead td');
    const headers: string[] = [];

    if (headerCells.length > 0) {
      for (const cell of headerCells) {
        headers.push(cell.textContent?.trim() ?? '');
      }
    } else {
      const firstRow = table.querySelector('tr');
      if (firstRow) {
        for (const cell of firstRow.querySelectorAll('th, td')) {
          headers.push(cell.textContent?.trim() ?? '');
        }
      }
    }

    const bodyRows = table.querySelectorAll('tbody tr');
    const dataRows = bodyRows.length > 0
      ? bodyRows
      : table.querySelectorAll('tr');

    const rows: string[][] = [];

    for (const row of dataRows) {
      if (row.closest('thead')) {
        continue;
      }
      const cells: string[] = [];
      for (const cell of row.querySelectorAll('td, th')) {
        cells.push(cell.textContent?.trim() ?? '');
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    results.push({ headers, rows });
  }

  return successResponse(requestId, {
    type: 'table',
    data: results,
  });
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

/** Extracts requested attribute values from matched elements. */
function extractAttributes(
  requestId: string,
  selector?: string,
  attributes?: string[],
): CommandResponse {
  if (!selector) {
    return successResponse(requestId, {
      type: 'attributes',
      data: [],
    });
  }

  const elements = resolveElements(selector);
  const attrs = attributes ?? [];
  const results: Record<string, string>[] = [];

  for (const element of elements) {
    const entry: Record<string, string> = {};

    if (attrs.length === 0) {
      for (const attr of element.attributes) {
        entry[attr.name] = attr.value;
      }
    } else {
      for (const attrName of attrs) {
        const value = element.getAttribute(attrName);
        if (value !== null) {
          entry[attrName] = value;
        }
      }
    }

    results.push(entry);
  }

  return successResponse(requestId, {
    type: 'attributes',
    data: results,
  });
}

// ---------------------------------------------------------------------------
// Structured data extraction
// ---------------------------------------------------------------------------

/** Generic structured data extraction combining multiple extraction types. */
function extractStructuredData(
  requestId: string,
  selector?: string,
): CommandResponse {
  const elements = selector ? resolveElements(selector) : [document.body];

  const results: Array<{
    tag: string;
    text: string;
    attributes: Record<string, string>;
    children: number;
  }> = [];

  for (const element of elements) {
    const attrs: Record<string, string> = {};
    for (const attr of element.attributes) {
      attrs[attr.name] = attr.value;
    }

    results.push({
      tag: element.tagName.toLowerCase(),
      text: element.textContent?.trim().slice(0, 500) ?? '',
      attributes: attrs,
      children: element.children.length,
    });
  }

  return successResponse(requestId, {
    type: 'structured',
    data: results,
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Page metadata extraction
// ---------------------------------------------------------------------------

/** Extracts page metadata including title, meta tags, OG data, favicon, and language. */
function extractPageMetadata(requestId: string): CommandResponse {
  const title = document.title || '';

  const metaTags: Record<string, string> = {};
  const ogData: Record<string, string> = {};

  const metaElements = document.querySelectorAll('meta');
  for (const meta of metaElements) {
    const name = meta.getAttribute('name') || meta.getAttribute('property') || '';
    const content = meta.getAttribute('content') || '';
    if (!name || !content) continue;

    if (name.startsWith('og:')) {
      ogData[name.slice(3)] = content;
    }
    metaTags[name] = content;
  }

  const canonicalLink = document.querySelector('link[rel="canonical"]');
  const canonicalUrl = canonicalLink ? canonicalLink.getAttribute('href') || undefined : undefined;

  const language = document.documentElement.lang || undefined;

  const faviconLink = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
  const favicon = faviconLink ? faviconLink.getAttribute('href') || undefined : undefined;

  const description = metaTags['description'] || undefined;

  const openGraph = {
    title: ogData['title'] || undefined,
    description: ogData['description'] || undefined,
    image: ogData['image'] || undefined,
    url: ogData['url'] || undefined,
    type: ogData['type'] || undefined,
    siteName: ogData['site_name'] || undefined,
  };

  return successResponse(requestId, {
    title,
    description,
    canonicalUrl,
    language,
    favicon,
    openGraph,
    metaTags,
  });
}

export {
  getFullHTML,
  getElementHTML,
  extractTableData,
  extractAttributes,
  extractStructuredData,
  extractPageMetadata,
};

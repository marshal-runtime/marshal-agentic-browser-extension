import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** MCP tool definition with JSON Schema inputSchema for the protocol. */
export interface BrowserToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Tool['inputSchema'];
}

/** All browser tool definitions for Phases 1-5. */
export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  // Phase 1: Core navigation & interaction
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', format: 'uri' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, or click at raw x,y viewport coordinates (no selector required).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1, description: 'CSS selector of the element to click. Optional when x and y are provided.' },
        x: { type: 'number', description: 'Viewport x coordinate for coordinate-based click.' },
        y: { type: 'number', description: 'Viewport y coordinate for coordinate-based click.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'integer', minimum: 1 },
        timeout: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input element identified by a CSS selector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1 },
        text: { type: 'string' },
        delay: { type: 'integer', minimum: 0 },
        clearFirst: { type: 'boolean' },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_select',
    description: 'Select an option in a <select> element by value, label, or index.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1 },
        value: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
        label: { type: 'string' },
        index: { type: 'integer', minimum: 0 },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element identified by a CSS selector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1 },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page or a specific element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1 },
        x: { type: 'number' },
        y: { type: 'number' },
        behavior: { type: 'string', enum: ['auto', 'smooth'] },
        timeout: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'browser_keyboard',
    description: 'Press a key or key combination. Supports single keys (Tab, Enter, Escape, ArrowDown, etc.) and combos with modifiers (Control+a, Shift+Tab, Control+Shift+ArrowUp). Modifier names: Control (or Ctrl), Shift, Alt, Meta (or Cmd).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', minLength: 1, description: 'Key or combo string, e.g. "Tab", "Enter", "Control+a", "Shift+ArrowDown"' },
      },
      required: ['key'],
    },
  },

  // Phase 2: Observation & extraction
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the page or a specific element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1 },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        fullPage: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_accessibility_tree',
    description: 'Get a compact YAML accessibility snapshot of the current page. Interactive elements are marked with [ref=eN] identifiers. Use these refs with browser_click and browser_type.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'browser_get_html',
    description: 'Get the HTML content of the page or a specific element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_extract_data',
    description: 'Extract structured data from the page (table, attributes, or structured).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['table', 'attributes', 'structured'] },
        selector: { type: 'string' },
        attributes: { type: 'array', items: { type: 'string' } },
      },
      required: ['type'],
    },
  },

  // Phase 2: Tab management
  {
    name: 'browser_create_tab',
    description: 'Create a new browser tab, optionally navigating to a URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', format: 'uri' },
        active: { type: 'boolean' },
        windowId: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a browser tab by its tab ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'integer', minimum: 1 },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch to a browser tab by its tab ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'integer', minimum: 1 },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_list_tabs',
    description: 'List all open browser tabs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'browser_list_targets',
    description: 'List ALL CDP targets including pages, iframes, service workers, and other contexts. Use this to discover iframe target IDs for browser_execute_script with targetId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['page', 'iframe', 'worker', 'service_worker', 'other'], description: 'Filter targets by type. Omit to list all.' },
      },
    },
  },

  // Phase 2: Dialog handling
  {
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss a JavaScript dialog (alert, confirm, prompt).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'] },
        promptText: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_get_dialog_info',
    description: 'Get information about the currently displayed JavaScript dialog.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // Phase 3: Wait operations
  {
    name: 'browser_wait_for_selector',
    description:
      'Wait for an element matching a CSS selector to appear, become visible, or be hidden.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1 },
        condition: { type: 'string', enum: ['visible', 'hidden', 'present'] },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_wait_for_navigation',
    description: 'Wait for a page navigation to complete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        timeout: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'browser_wait_for_network_idle',
    description: 'Wait for network activity to become idle.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        idleThreshold: { type: 'integer', minimum: 1 },
        timeout: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'browser_wait_for_condition',
    description: 'Wait for a JavaScript expression to evaluate to true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', minLength: 1 },
        pollingInterval: { type: 'integer', minimum: 1 },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['expression'],
    },
  },

  // Phase 5: Script execution & UI modification
  {
    name: 'browser_execute_script',
    description: 'Execute a JavaScript snippet in the page context and return the result. Use targetId to execute inside a specific iframe or worker target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        script: { type: 'string', minLength: 1 },
        args: { type: 'array', items: {} },
        timeout: { type: 'integer', minimum: 1 },
        world: { type: 'string', enum: ['MAIN', 'ISOLATED'] },
        targetId: { type: 'string', description: 'CDP target ID to execute in (e.g. an iframe target). Use browser_list_targets to discover available targets.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'browser_execute_script_file',
    description: 'Load and execute a JavaScript file from a URL in the page context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file: { type: 'string', minLength: 1, description: 'URL or path of the JavaScript file to execute' },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['file'],
    },
  },
  {
    name: 'browser_validate',
    description: 'Execute a validation script with assert/skip helpers and return structured pass/fail results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        script: { type: 'string', minLength: 1, description: 'Validation script body using assert(name, condition, message) and skip(name, message)' },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['script'],
    },
  },
  {
    name: 'browser_console',
    description: 'Execute a console command and capture console output with log levels.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', minLength: 1 },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['command'],
    },
  },
  {
    name: 'browser_modify_html',
    description: 'Modify HTML content on the page (change text, add/remove elements, modify attributes).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['modifyText', 'addElement', 'removeElement', 'modifyAttribute'] },
        selector: { type: 'string', minLength: 1 },
        text: { type: 'string' },
        html: { type: 'string' },
        position: { type: 'string', enum: ['beforebegin', 'afterbegin', 'beforeend', 'afterend'] },
        attribute: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['action', 'selector'],
    },
  },
  {
    name: 'browser_modify_css',
    description: 'Modify CSS styles on the page (set inline styles, add/remove classes, inject stylesheets).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['setStyle', 'addClass', 'removeClass', 'injectStylesheet'] },
        selector: { type: 'string' },
        styles: { type: 'object', additionalProperties: { type: 'string' } },
        className: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['action'],
    },
  },

  // Phase 6: Remote browser connection
  {
    name: 'browser_connect_remote',
    description: 'Connect to a remote browser via WebSocket using the Chrome DevTools Protocol.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        wsUrl: { type: 'string', description: 'WebSocket URL of the remote browser (e.g. ws://localhost:9222)' },
        bearerToken: { type: 'string', description: 'Optional bearer token for authentication' },
        timeout: { type: 'integer', minimum: 1, description: 'Connection timeout in milliseconds' },
      },
      required: ['wsUrl'],
    },
  },
  {
    name: 'browser_disconnect_remote',
    description: 'Disconnect from the currently connected remote browser.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },


  // Phase 7: Storage management
  {
    name: 'browser_get_storage',
    description: 'Get browser storage data (cookies, localStorage, or sessionStorage).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['getCookies', 'getLocalStorage', 'getSessionStorage'],
        },
        domain: { type: 'string' },
        url: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_set_storage',
    description: 'Set browser storage data (cookies, localStorage, or sessionStorage).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['setCookie', 'setLocalStorage', 'setSessionStorage'],
        },
        key: { type: 'string' },
        value: { type: 'string' },
        cookie: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
            domain: { type: 'string' },
            path: { type: 'string' },
            secure: { type: 'boolean' },
            httpOnly: { type: 'boolean' },
            sameSite: { type: 'string', enum: ['strict', 'lax', 'none'] },
            expirationDate: { type: 'number' },
            url: { type: 'string' },
          },
          required: ['name', 'value'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_clear_storage',
    description: 'Clear browser storage (all localStorage and sessionStorage) or delete a specific cookie.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['clearStorage', 'deleteCookie'],
        },
        url: { type: 'string' },
        domain: { type: 'string' },
        cookieName: { type: 'string' },
      },
      required: ['action'],
    },
  },

  // Phase 7: File upload/download
  {
    name: 'browser_file_upload',
    description: 'Set file paths on an input[type=file] element to simulate file selection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', minLength: 1, description: 'CSS selector for the file input element' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to set' },
      },
      required: ['selector', 'filePaths'],
    },
  },
  {
    name: 'browser_download',
    description: 'Start a download or check the status of an existing download.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['startDownload', 'downloadStatus'], description: 'Whether to start a download or check status' },
        url: { type: 'string', description: 'URL to download (required for startDownload)' },
        downloadId: { type: 'integer', minimum: 1, description: 'Download ID to check (required for downloadStatus)' },
      },
      required: ['action'],
    },
  },

  // Phase 7: Navigation history
  {
    name: 'browser_go_back',
    description: 'Navigate the current tab back in browser history.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'browser_go_forward',
    description: 'Navigate the current tab forward in browser history.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page. Optionally bypass the cache for a hard reload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        hard: { type: 'boolean', description: 'If true, bypass the cache (hard reload)' },
      },
    },
  },

  // Phase 4: Network interception
  {
    name: 'browser_intercept_network',
    description: 'Intercept, modify, or block network requests using CDP Fetch domain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['enableInterception', 'disableInterception', 'getInterceptedRequests', 'modifyRequest', 'blockRequest'],
        },
        tabId: { type: 'integer', minimum: 1 },
        patterns: { type: 'array', items: { type: 'string' } },
        requestId: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        responseHeaders: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        responseCode: { type: 'integer', minimum: 1 },
      },
      required: ['action'],
    },
  },

  // Phase 8: Native browser APIs (bookmarks, history, downloads)
  {
    name: 'browser_bookmarks',
    description: 'List, create, or search browser bookmarks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'search'] },
        parentId: { type: 'string', description: 'Parent folder ID for listing or creating' },
        title: { type: 'string', description: 'Bookmark title (required for create)' },
        url: { type: 'string', description: 'Bookmark URL (omit for folders)' },
        query: { type: 'string', description: 'Search query (required for search)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_history',
    description: 'Search or retrieve browser history entries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['search', 'getEntries'] },
        text: { type: 'string', description: 'Search text matching URL or title' },
        startTime: { type: 'number', description: 'Start time filter (epoch ms)' },
        endTime: { type: 'number', description: 'End time filter (epoch ms)' },
        maxResults: { type: 'integer', minimum: 1, description: 'Maximum number of results' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_downloads',
    description: 'Retrieve download items or monitor active downloads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['getItems', 'monitor'] },
        query: { type: 'string', description: 'Filename/URL search query' },
        state: { type: 'string', enum: ['in_progress', 'interrupted', 'complete'], description: 'Filter by download state' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of results' },
      },
      required: ['action'],
    },
  },

  // Page metadata extraction
  {
    name: 'browser_get_metadata',
    description: 'Extract page metadata including title, description, canonical URL, Open Graph data, favicon, and language.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },

  // Runtime backend switching & tool discovery
  {
    name: 'browser_switch_backend',
    description: 'Switch the browser adapter backend at runtime (chrome, edge, or remote) without restarting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        backend: { type: 'string', enum: ['chrome', 'edge', 'remote'], description: 'Target backend to switch to' },
        wsUrl: { type: 'string', description: 'WebSocket URL (required for remote backend)' },
        bearerToken: { type: 'string', description: 'Optional bearer token for remote authentication' },
        timeout: { type: 'integer', minimum: 1, description: 'Connection timeout in milliseconds' },
      },
      required: ['backend'],
    },
  },
  {
    name: 'browser_list_tools',
    description: 'List available browser tools, optionally filtered by backend capabilities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        backend: { type: 'string', enum: ['chrome', 'edge', 'remote'], description: 'Filter tools by backend support' },
        category: { type: 'string', description: 'Filter tools by category' },
      },
    },
  },

  // Mobile device emulation
  {
    name: 'browser_emulate_device',
    description: 'Emulate a mobile device with configurable screen size, user agent, touch support, and orientation. Use action "reset" to revert to desktop mode.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['emulate', 'reset'], description: 'Emulate a device or reset to desktop' },
        preset: {
          type: 'string',
          enum: ['iPhone 14', 'iPhone 14 Pro Max', 'Pixel 7', 'iPad Pro', 'Galaxy S23'],
          description: 'Device preset name (overrides width/height/scale/userAgent)',
        },
        width: { type: 'integer', minimum: 1, description: 'Viewport width in pixels' },
        height: { type: 'integer', minimum: 1, description: 'Viewport height in pixels' },
        deviceScaleFactor: { type: 'number', minimum: 0.1, description: 'Device pixel ratio' },
        mobile: { type: 'boolean', description: 'Whether to emulate a mobile device' },
        userAgent: { type: 'string', description: 'Custom user agent string' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Screen orientation' },
        touchEnabled: { type: 'boolean', description: 'Enable touch event emulation' },
      },
      required: ['action'],
    },
  },

  // Undo/revert modifications
  {
    name: 'browser_undo_modification',
    description: 'Undo the last HTML or CSS modification on the page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['undoLastHTML', 'revertAllHTML', 'undoLastCSS', 'revertAllCSS'] },
        tabId: { type: 'integer', minimum: 1 },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_revert_all',
    description: 'Revert all HTML or CSS modifications, restoring the page to its original state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['revertAllHTML', 'revertAllCSS'] },
        tabId: { type: 'integer', minimum: 1 },
      },
      required: ['action'],
    },
  },

  // Session management
  {
    name: 'browser_export_session',
    description: 'Export the current session state (tabs, scroll positions, connections) as JSON.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'browser_import_session',
    description: 'Import a previously exported session state from JSON.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        data: { type: 'string', description: 'JSON-encoded session state to import' },
      },
      required: ['data'],
    },
  },
];

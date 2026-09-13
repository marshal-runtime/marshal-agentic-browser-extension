#!/usr/bin/env node

/**
 * Agentic Browser CLI
 *
 * A standalone command-line tool for AI agents to control browsers.
 * Two engines:
 *   - chrome|edge (default): raw Chrome DevTools Protocol against your
 *     installed browser, with your real user profile.
 *   - webkit|safari: Playwright WebKit via a local daemon. This is the
 *     WebKit engine (what Safari uses), NOT your installed Safari.app —
 *     fresh ephemeral profile, no Safari cookies/logins.
 *
 * Usage:
 *   agentic-browser setup [--browser chrome|edge|webkit|safari] [--port 9222] [--headless]
 *   agentic-browser <command> [options]
 *
 * All commands print JSON to stdout. Diagnostic messages go to stderr.
 */

import { parseArgs } from 'node:util';
import { loadConfig, saveConfig } from './config.js';
import { setCDPHost, getVersion } from './cdp.js';
import { launchBrowser, shutdownBrowser } from './launcher.js';
import { normalizeBrowserFlag } from './engine.js';
import { runWebkitCommand } from './webkit-client.js';
import * as cmd from './commands.js';
import { setTargetOverride } from './commands.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
  const usage = `
Agentic Browser CLI — Control browsers from the command line.

LIFECYCLE:
  setup                       Launch browser with your profile & enable remote control
  connect                     Connect to an existing browser (local or remote)
  status                      Check if a browser is connected
  profile-info                Show loaded profile, cookies, and logged-in services
  shutdown                    Stop the managed browser

NAVIGATION:
  navigate <url>              Navigate to a URL
  go-back                     Go back in history
  go-forward                  Go forward in history
  reload [--hard]             Reload the page

DOM INTERACTION:
  click <selector>            Click an element
  click --x N --y N           Click at raw x,y viewport coordinates
                              Options: --click-count N, --button left|right|middle
                              --modifiers ctrl,shift,alt,meta
  type <selector> <text>      Type text into an element (--clear to clear first)
  type --text "hello"         Type at cursor position (no selector, uses Input.insertText)
  select <selector>           Select a dropdown option (--value|--label|--index)
  hover <selector>            Hover over an element
  scroll [--x N] [--y N]     Scroll the page or an element (--selector)
  keyboard <key>              Press a key or combo (Tab, Enter, Control+a, Shift+ArrowDown)
                              --modifiers ctrl,shift,alt,meta (alternative to combo syntax)
  drag                        Mouse drag for text selection, sliders, DnD
                              --start-x N --start-y N --end-x N --end-y N
                              [--steps N] [--modifiers shift]

CONTENT EXTRACTION:
  screenshot [--output file]  Capture a screenshot (--full-page, --selector, --format)
  html [--selector sel]       Get page or element HTML
  accessibility-tree          Get the accessibility tree
  extract-data <type>         Extract structured data ("table" or "structured")
  metadata                    Get page metadata (title, OG tags, etc.)

SCRIPT EXECUTION:
  execute <script>            Execute JavaScript and return result
  execute <script> --target <id>  Execute JS in a specific target (iframe/worker)
  console <command>           Run a console command

WAIT OPERATIONS:
  wait-for-selector <sel>     Wait for element (--condition visible|hidden|present)
  wait-for-navigation         Wait for page navigation to complete
  wait-for-network-idle       Wait for network activity to settle
  wait-for-condition <expr>   Wait for JS expression to be truthy

TAB MANAGEMENT:
  list-tabs                   List all open browser tabs
  list-targets                List ALL CDP targets (pages, iframes, workers, etc.)
  create-tab [--url <url>]    Open a new tab
  switch-tab <target-id>      Switch to a tab by its target ID
  close-tab <target-id>       Close a tab by its target ID

DEVICE EMULATION:
  emulate-device              Emulate a device (--preset name | --width/--height)
  reset-emulation             Reset to desktop viewport

DIALOG HANDLING:
  handle-dialog <action>      Accept or dismiss a JS dialog (--trigger <expr> --prompt-text)

FILE OPERATIONS:
  upload-file <sel> <file...>  Set file(s) on a file input element
  download <url>               Download a file (--output path, --timeout)

NETWORK:
  network-log                  Capture network traffic (--duration ms, default 5000)

COOKIES:
  get-cookies [--domain X]     Get browser cookies (optionally filter by domain)
  set-cookie                   Set a cookie (--name, --value, --domain, --path, ...)
  delete-cookie                Delete a cookie (--name, --domain)

DOM MODIFICATION:
  inject-css <css>             Inject a stylesheet into the page
  modify-attribute <sel> <attr> [val]  Set or remove an element attribute
  insert-html <sel> <html>     Insert HTML adjacent to an element (--position)
  remove-element <sel>         Remove an element from the DOM

OPTIONS:
  --port <number>             CDP port (default: 9222)
  --host <address>            CDP host for remote browsers (default: 127.0.0.1)
  --target <id>               Connect to a specific CDP target (use list-targets to find IDs)
                              Works on ANY command (click, type, screenshot, execute, etc.)
                              Supports prefix matching — you don't need the full ID
  --browser <name>            Browser engine for setup:
                                chrome|edge  — your installed browser via CDP,
                                               loads your real user profile
                                webkit|safari — Playwright WebKit engine (the
                                               engine Safari uses). NOT your
                                               installed Safari: fresh ephemeral
                                               profile, no Safari cookies/logins.
                                               No CDP: connect/list-targets/--target
                                               and UA emulation are unavailable.
  --headless                  Launch in headless mode
  --expose                    Bind to 0.0.0.0 so remote agents can connect (chrome/edge only)
  --profile <name>            Chrome profile directory name (e.g., "Profile 1"; chrome/edge only)
  --help                      Show this help message

EXAMPLES:
  agentic-browser setup
  agentic-browser navigate "https://github.com"
  agentic-browser click "#login-button"
  agentic-browser screenshot --output page.png --full-page
  agentic-browser type "#search" "hello world"
  agentic-browser execute "document.title"
`;
  process.stderr.write(usage.trim() + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const command = rawArgs[0]!;
  const rest = rawArgs.slice(1);

  // Parse common flags
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      browser: { type: 'string', short: 'b' },
      headless: { type: 'boolean' },
      expose: { type: 'boolean' },
      profile: { type: 'string' },
      selector: { type: 'string', short: 's' },
      output: { type: 'string', short: 'o' },
      format: { type: 'string' },
      quality: { type: 'string' },
      'full-page': { type: 'boolean' },
      hard: { type: 'boolean' },
      value: { type: 'string' },
      label: { type: 'string' },
      index: { type: 'string' },
      x: { type: 'string' },
      y: { type: 'string' },
      url: { type: 'string' },
      condition: { type: 'string' },
      timeout: { type: 'string' },
      preset: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      'device-scale-factor': { type: 'string' },
      mobile: { type: 'boolean' },
      'user-agent': { type: 'string' },
      orientation: { type: 'string' },
      'prompt-text': { type: 'string' },
      trigger: { type: 'string' },
      clear: { type: 'boolean' },
      button: { type: 'string' },
      action: { type: 'string' },
      'max-depth': { type: 'string' },
      dir: { type: 'string' },
      duration: { type: 'string' },
      domain: { type: 'string' },
      name: { type: 'string' },
      path: { type: 'string' },
      secure: { type: 'boolean' },
      'http-only': { type: 'boolean' },
      'same-site': { type: 'string' },
      expires: { type: 'string' },
      position: { type: 'string' },
      target: { type: 'string' },
      modifiers: { type: 'string' },
      'click-count': { type: 'string' },
      'start-x': { type: 'string' },
      'start-y': { type: 'string' },
      'end-x': { type: 'string' },
      'end-y': { type: 'string' },
      steps: { type: 'string' },
      text: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });

  const config = loadConfig();
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const num = (v: string | boolean | undefined): number | undefined => {
    const s = str(v);
    return s !== undefined ? parseInt(s, 10) : undefined;
  };
  const float = (v: string | boolean | undefined): number | undefined => {
    const s = str(v);
    return s !== undefined ? parseFloat(s) : undefined;
  };

  const port = num(values['port']) ?? config.port;
  const host = str(values['host']) ?? config.host ?? '127.0.0.1';
  setCDPHost(host);

  // --target makes ANY command connect to a specific CDP target (page, iframe, worker)
  const targetId = str(values['target']);
  setTargetOverride(targetId);

  const positionals = rest.filter((a) => !a.startsWith('-') && !isOptionValue(rest, a));

  let result: { success: boolean; [key: string]: unknown };

  try {
    // Engine selection: --browser webkit|safari → Playwright WebKit daemon;
    // chrome|edge (or no flag) → raw CDP. After a webkit setup, saved config
    // routes follow-up commands to the daemon.
    const selection = normalizeBrowserFlag(str(values['browser']));
    const engine = selection?.engine ?? config.engine ?? 'cdp';

    if (engine === 'webkit') {
      result = await runWebkitCommand(command, {
        port,
        host,
        values: values as Record<string, string | boolean | undefined>,
        positionals,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.success ? 0 : 1);
    }

    switch (command) {
      // -- Lifecycle --
      case 'setup': {
        const cdpPreferred =
          selection?.browser === 'chrome' || selection?.browser === 'edge'
            ? selection.browser
            : config.browser === 'chrome' || config.browser === 'edge'
              ? config.browser
              : undefined;
        const info = await launchBrowser({
          browser: cdpPreferred,
          port,
          headless: values['headless'] === true,
          expose: values['expose'] === true,
          profile: str(values['profile']),
        });
        saveConfig({ port, host: '127.0.0.1', browser: info.browser, engine: 'cdp' });
        result = {
          success: true,
          browser: info.browser,
          port: info.port,
          profileDir: info.profileDir,
          wsUrl: info.wsUrl,
          exposed: values['expose'] === true,
          message: `${info.browser} is ready on port ${String(info.port)}`,
        };
        break;
      }

      case 'connect': {
        // Connect to an existing browser (local or remote) and save config
        saveConfig({ port, host });
        const connectVersion = await getVersion(port);
        if (connectVersion) {
          result = { success: true, connected: true, host, port, ...connectVersion };
        } else {
          result = {
            success: false,
            error: `Cannot connect to browser at ${host}:${String(port)}`,
          };
        }
        break;
      }

      case 'status': {
        const version = await getVersion(port);
        if (version) {
          result = { success: true, connected: true, host, port, ...version };
        } else {
          result = {
            success: true,
            connected: false,
            message: `No browser at ${host}:${String(port)}`,
          };
        }
        break;
      }

      case 'profile-info':
        result = await cmd.profileInfo(port);
        break;

      case 'shutdown': {
        shutdownBrowser(port);
        result = { success: true, message: 'Browser stopped' };
        break;
      }

      // -- Navigation --
      case 'navigate': {
        const url = positionals[0];
        if (!url) {
          result = { success: false, error: 'Usage: agentic-browser navigate <url>' };
          break;
        }
        result = await cmd.navigate(port, url, str(values['condition']));
        break;
      }

      case 'go-back':
        result = await cmd.goBack(port);
        break;

      case 'go-forward':
        result = await cmd.goForward(port);
        break;

      case 'reload':
        result = await cmd.reload(port, values['hard'] === true);
        break;

      // -- DOM Interaction --
      case 'click': {
        const selector = positionals[0] ?? str(values['selector']);
        const rawX = num(values['x']);
        const rawY = num(values['y']);
        if (!selector && (rawX === undefined || rawY === undefined)) {
          result = {
            success: false,
            error: 'Usage: agentic-browser click <selector>  OR  agentic-browser click --x N --y N',
          };
          break;
        }
        const clickModifiers = cmd.parseModifierFlags(str(values['modifiers']));
        result = await cmd.click(
          port,
          selector,
          (str(values['button']) as 'left' | 'right' | 'middle') ?? 'left',
          rawX,
          rawY,
          num(values['click-count']) ?? 1,
          clickModifiers,
        );
        break;
      }

      case 'type': {
        const textFlag = str(values['text']);
        if (textFlag !== undefined) {
          // Type at cursor position using Input.insertText (no selector)
          result = await cmd.typeAtCursor(port, textFlag);
        } else {
          const selector = positionals[0];
          const text = positionals[1];
          if (!selector || !text) {
            result = {
              success: false,
              error:
                'Usage: agentic-browser type <selector> <text>  OR  agentic-browser type --text "hello"',
            };
            break;
          }
          result = await cmd.type(port, selector, text, values['clear'] === true);
        }
        break;
      }

      case 'select': {
        const selector = positionals[0] ?? str(values['selector']);
        if (!selector) {
          result = { success: false, error: 'Usage: agentic-browser select <selector>' };
          break;
        }
        result = await cmd.select(
          port,
          selector,
          str(values['value']),
          str(values['label']),
          num(values['index']),
        );
        break;
      }

      case 'hover': {
        const selector = positionals[0] ?? str(values['selector']);
        if (!selector) {
          result = { success: false, error: 'Usage: agentic-browser hover <selector>' };
          break;
        }
        result = await cmd.hover(port, selector);
        break;
      }

      case 'scroll':
        result = await cmd.scroll(
          port,
          num(values['x']) ?? 0,
          num(values['y']) ?? 0,
          str(values['selector']),
        );
        break;

      case 'keyboard': {
        let keyCombo = positionals[0];
        if (!keyCombo) {
          result = {
            success: false,
            error:
              'Usage: agentic-browser keyboard <key>  (e.g. Tab, Enter, Control+a, Shift+ArrowDown)\n       agentic-browser keyboard <key> --modifiers ctrl,shift',
          };
          break;
        }
        // Merge --modifiers flag into the combo string
        const modFlag = str(values['modifiers']);
        if (modFlag) {
          const modNames = modFlag.split(',').map((m) => {
            const lower = m.trim().toLowerCase();
            if (lower === 'ctrl' || lower === 'control') return 'Control';
            if (lower === 'cmd' || lower === 'command' || lower === 'meta') return 'Meta';
            if (lower === 'alt') return 'Alt';
            if (lower === 'shift') return 'Shift';
            return m.trim();
          });
          keyCombo = [...modNames, keyCombo].join('+');
        }
        result = await cmd.pressKey(port, keyCombo);
        break;
      }

      // -- Content Extraction --
      case 'screenshot':
        result = await cmd.screenshot(port, {
          selector: str(values['selector']),
          format: str(values['format']),
          quality: num(values['quality']),
          fullPage: values['full-page'] === true,
          output: str(values['output']),
        });
        break;

      case 'html':
        result = await cmd.getHtml(port, str(values['selector']));
        break;

      case 'accessibility-tree':
        result = await cmd.accessibilityTree(port, num(values['max-depth']));
        break;

      case 'extract-data': {
        const type = positionals[0] ?? str(values['action']);
        if (!type) {
          result = {
            success: false,
            error: 'Usage: agentic-browser extract-data <table|structured>',
          };
          break;
        }
        result = await cmd.extractData(port, type, str(values['selector']));
        break;
      }

      case 'metadata':
        result = await cmd.getMetadata(port);
        break;

      // -- Script Execution --
      case 'execute': {
        const script = positionals[0];
        if (!script) {
          result = {
            success: false,
            error: 'Usage: agentic-browser execute <script> [--target <target-id>]',
          };
          break;
        }
        const targetId = str(values['target' as keyof typeof values]);
        if (targetId) {
          result = await cmd.executeInTarget(port, script, targetId);
        } else {
          result = await cmd.executeScript(port, script);
        }
        break;
      }

      case 'list-targets': {
        const { listTargets: listTargetsFn } = await import('./cdp.js');
        const allTargets = await listTargetsFn(port);
        result = {
          success: true,
          targets: allTargets.map((t) => ({
            id: t.id,
            type: t.type,
            title: t.title,
            url: t.url,
            connectable: !!t.webSocketDebuggerUrl,
          })),
          count: allTargets.length,
        };
        break;
      }

      case 'drag': {
        const startX = num(values['start-x']);
        const startY = num(values['start-y']);
        const endX = num(values['end-x']);
        const endY = num(values['end-y']);
        if (
          startX === undefined ||
          startY === undefined ||
          endX === undefined ||
          endY === undefined
        ) {
          result = {
            success: false,
            error:
              'Usage: agentic-browser drag --start-x N --start-y N --end-x N --end-y N [--steps N] [--modifiers shift]',
          };
          break;
        }
        result = await cmd.drag(
          port,
          startX,
          startY,
          endX,
          endY,
          num(values['steps']) ?? 10,
          cmd.parseModifierFlags(str(values['modifiers'])),
        );
        break;
      }

      case 'console': {
        const command = positionals[0];
        if (!command) {
          result = { success: false, error: 'Usage: agentic-browser console <command>' };
          break;
        }
        result = await cmd.executeConsole(port, command);
        break;
      }

      // -- Wait Operations --
      case 'wait-for-selector': {
        const selector = positionals[0] ?? str(values['selector']);
        if (!selector) {
          result = { success: false, error: 'Usage: agentic-browser wait-for-selector <selector>' };
          break;
        }
        result = await cmd.waitForSelector(
          port,
          selector,
          (str(values['condition']) as 'visible' | 'hidden' | 'present') ?? 'visible',
          num(values['timeout']),
        );
        break;
      }

      case 'wait-for-navigation':
        result = await cmd.waitForNavigation(port, num(values['timeout']));
        break;

      case 'wait-for-network-idle':
        result = await cmd.waitForNetworkIdle(port, num(values['timeout']));
        break;

      case 'wait-for-condition': {
        const expr = positionals[0];
        if (!expr) {
          result = {
            success: false,
            error: 'Usage: agentic-browser wait-for-condition <expression>',
          };
          break;
        }
        result = await cmd.waitForCondition(port, expr, num(values['timeout']));
        break;
      }

      // -- Tab Management --
      case 'list-tabs':
        result = await cmd.listTabs(port);
        break;

      case 'create-tab':
        result = await cmd.createTab(port, str(values['url']) ?? positionals[0]);
        break;

      case 'switch-tab': {
        const targetId = positionals[0];
        if (!targetId) {
          result = { success: false, error: 'Usage: agentic-browser switch-tab <target-id>' };
          break;
        }
        result = await cmd.switchTab(port, targetId);
        break;
      }

      case 'close-tab': {
        const targetId = positionals[0];
        if (!targetId) {
          result = { success: false, error: 'Usage: agentic-browser close-tab <target-id>' };
          break;
        }
        result = await cmd.closeTab(port, targetId);
        break;
      }

      // -- Device Emulation --
      case 'emulate-device':
        result = await cmd.emulateDevice(port, {
          action: 'emulate',
          preset: str(values['preset']),
          width: num(values['width']),
          height: num(values['height']),
          deviceScaleFactor: float(values['device-scale-factor']),
          mobile: values['mobile'] === true,
          userAgent: str(values['user-agent']),
          orientation: str(values['orientation']) as 'portrait' | 'landscape' | undefined,
        });
        break;

      case 'reset-emulation':
        result = await cmd.emulateDevice(port, { action: 'reset' });
        break;

      // -- Dialog Handling --
      case 'handle-dialog': {
        const action = (positionals[0] ?? str(values['action'])) as
          | 'accept'
          | 'dismiss'
          | undefined;
        if (!action || !['accept', 'dismiss'].includes(action)) {
          result = {
            success: false,
            error: 'Usage: agentic-browser handle-dialog <accept|dismiss> --trigger <expr>',
          };
          break;
        }
        const trigger = str(values['trigger']);
        if (!trigger) {
          result = {
            success: false,
            error: 'Missing --trigger <expression>. Provide the JS that triggers the dialog.',
          };
          break;
        }
        result = await cmd.handleDialog(
          port,
          action,
          trigger,
          str(values['prompt-text']),
          num(values['timeout']),
        );
        break;
      }

      // -- File Operations --
      case 'upload-file': {
        const selector = positionals[0] ?? str(values['selector']);
        if (!selector) {
          result = {
            success: false,
            error: 'Usage: agentic-browser upload-file <selector> <file...>',
          };
          break;
        }
        const files = positionals.slice(1);
        if (files.length === 0) {
          result = {
            success: false,
            error: 'Usage: agentic-browser upload-file <selector> <file...>',
          };
          break;
        }
        result = await cmd.uploadFile(port, selector, files);
        break;
      }

      case 'download': {
        const dlUrl = positionals[0] ?? str(values['url']);
        if (!dlUrl) {
          result = {
            success: false,
            error: 'Usage: agentic-browser download <url> [--output path]',
          };
          break;
        }
        result = await cmd.download(port, dlUrl, str(values['output']), num(values['timeout']));
        break;
      }

      // -- Network --
      case 'network-log':
        result = await cmd.networkLog(port, num(values['duration']));
        break;

      // -- Cookies --
      case 'get-cookies':
        result = await cmd.getCookies(port, str(values['domain']));
        break;

      case 'set-cookie': {
        const cookieName = str(values['name']);
        const cookieValue = str(values['value']);
        const cookieDomain = str(values['domain']);
        if (!cookieName || !cookieValue || !cookieDomain) {
          result = {
            success: false,
            error: 'Usage: agentic-browser set-cookie --name X --value Y --domain D',
          };
          break;
        }
        result = await cmd.setCookie(port, {
          name: cookieName,
          value: cookieValue,
          domain: cookieDomain,
          path: str(values['path']),
          secure: values['secure'] === true,
          httpOnly: values['http-only'] === true,
          sameSite: str(values['same-site']),
          expires: num(values['expires']),
        });
        break;
      }

      case 'delete-cookie': {
        const delName = str(values['name']);
        const delDomain = str(values['domain']);
        if (!delName || !delDomain) {
          result = {
            success: false,
            error: 'Usage: agentic-browser delete-cookie --name X --domain D',
          };
          break;
        }
        result = await cmd.deleteCookie(port, delName, delDomain);
        break;
      }

      // -- DOM Modification --
      case 'inject-css': {
        const css = positionals[0];
        if (!css) {
          result = { success: false, error: 'Usage: agentic-browser inject-css <css>' };
          break;
        }
        result = await cmd.injectCSS(port, css);
        break;
      }

      case 'modify-attribute': {
        const selector = positionals[0] ?? str(values['selector']);
        const attribute = positionals[1];
        if (!selector || !attribute) {
          result = {
            success: false,
            error: 'Usage: agentic-browser modify-attribute <selector> <attribute> [value]',
          };
          break;
        }
        result = await cmd.modifyAttribute(port, selector, attribute, positionals[2]);
        break;
      }

      case 'insert-html': {
        const selector = positionals[0] ?? str(values['selector']);
        const html = positionals[1];
        if (!selector || !html) {
          result = {
            success: false,
            error:
              'Usage: agentic-browser insert-html <selector> <html> [--position beforebegin|afterbegin|beforeend|afterend]',
          };
          break;
        }
        result = await cmd.insertHTML(
          port,
          selector,
          html,
          (str(values['position']) as 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend') ??
            'beforeend',
        );
        break;
      }

      case 'remove-element': {
        const selector = positionals[0] ?? str(values['selector']);
        if (!selector) {
          result = { success: false, error: 'Usage: agentic-browser remove-element <selector>' };
          break;
        }
        result = await cmd.removeElement(port, selector);
        break;
      }

      default:
        result = {
          success: false,
          error: `Unknown command: ${command}. Run with --help for usage.`,
        };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    result = { success: false, error: message };
  }

  // Output JSON to stdout
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.success ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a string is a value for a preceding option flag. */
function isOptionValue(args: string[], arg: string): boolean {
  const idx = args.indexOf(arg);
  if (idx <= 0) return false;
  const prev = args[idx - 1];
  return prev !== undefined && prev.startsWith('-') && !prev.startsWith('--no-');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ success: false, error: message }, null, 2) + '\n');
  process.exit(1);
});

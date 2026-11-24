// Marley browser bridge: connects to the bridge server and runs its commands in the
// tabs of the "Marley" tab group. No model runs here; every step comes from the server.

import { blurSecrets, focusInFrame, isSecretField, locateRef, pageHasText, pasteSecret, readFocused, readSecretSource, selectFocusedContent, snapshotPage, unblurSecrets, writeClipboard } from "./page.js";
import { SITE_INSTALL } from "./install-channel.js";

// The local socket reaches a Marshal on this machine (developers). A store install (update_url) and a download from the Marley site
// (SITE_INSTALL, set by the site's packager) skip it and pair only with production.
const DEVELOPER_INSTALL = !chrome.runtime.getManifest().update_url && !SITE_INSTALL;
// The local Marshal socket (it allows evaluate) is opt-in: a developer types its URL in the popup, or Marshal writes it
// to marshal-bridge.json in the folder it loads unpacked (whoever can write that folder already has the same local
// access as typing the address). Never on a store or site install. A value stored from the popup, even empty, wins.
const DEFAULTS = { enabled: true };
const LOCAL_BRIDGE_URL = /^ws:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}\/bridge$/;
const CARRIED_BRIDGE_FILE = "marshal-bridge.json";
const GROUP_TITLE = "Marley";
const GROUP_COLOR = "purple";
const PING_MS = 20000;

let socket = null;
let pingTimer = null;
let reconnectTimer = null;
let backoffMs = 1000;
let lastError = null;
const attached = new Set();

// ---------- connection ----------

async function carriedBridgeUrl() {
  try {
    const response = await fetch(chrome.runtime.getURL(CARRIED_BRIDGE_FILE), { cache: "no-store" });
    if (!response.ok) return "";
    const { bridgeUrl } = await response.json();
    return typeof bridgeUrl === "string" ? bridgeUrl : "";
  } catch {
    return "";
  }
}

async function settings() {
  const stored = { ...DEFAULTS, ...(await chrome.storage.local.get(["enabled", "bridgeUrl"])) };
  if (!DEVELOPER_INSTALL) return { ...stored, bridgeUrl: "" };
  const bridgeUrl = typeof stored.bridgeUrl === "string" ? stored.bridgeUrl : await carriedBridgeUrl();
  return { ...stored, bridgeUrl: LOCAL_BRIDGE_URL.test(bridgeUrl) ? bridgeUrl : "" };
}

let connecting = null;

function connect() {
  connecting ??= openSocket().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function openSocket() {
  const { enabled, bridgeUrl } = await settings();
  if (!enabled || !bridgeUrl) {
    disconnect();
    return;
  }
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);
  let ws;
  try {
    ws = new WebSocket(bridgeUrl);
  } catch (error) {
    lastError = String(error?.message ?? error);
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    backoffMs = 1000;
    lastError = null;
    ws.send(JSON.stringify({ type: "hello", extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent, groupTitle: GROUP_TITLE }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), PING_MS);
    updateBadge();
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "request") handleRequest(ws, message);
  };
  ws.onerror = () => {
    lastError = `cannot reach ${bridgeUrl}`;
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(pingTimer);
    updateBadge();
    scheduleReconnect();
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (socket) {
    const ws = socket;
    socket = null;
    ws.onclose = null;
    ws.close();
  }
  updateBadge();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

async function updateBadge() {
  const { enabled } = await settings();
  const connected = socket?.readyState === WebSocket.OPEN || cloudState.status === "connected";
  await chrome.action.setBadgeText({ text: !enabled ? "off" : connected ? "on" : "…" });
  await chrome.action.setBadgeBackgroundColor({ color: !enabled ? "#888888" : connected ? "#7c3aed" : "#d97706" });
}

async function handleRequest(ws, { id, method, params }) {
  let reply;
  try {
    const handler = HANDLERS[method];
    if (!handler) throw codeError("unknown-method", `Unknown method ${method}`);
    reply = { type: "response", id, ok: true, result: await handler(params ?? {}) };
  } catch (error) {
    reply = { type: "response", id, ok: false, error: { code: error.code ?? "browser-error", message: String(error.message ?? error) } };
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------- tab group ----------

async function marleyGroups() {
  return chrome.tabGroups.query({ title: GROUP_TITLE });
}

// A page the Marley tab opens (a window.open popup such as the Fivetran card, a target=_blank link) cannot join a tab group, so it is adopted
// instead: Marley may use it because it came from a Marley tab. Nothing else of the person's tabs is ever listed or touched.
let adoptedIds = null;

async function adopted() {
  if (!adoptedIds) {
    const { adopted: stored } = await chrome.storage.session.get("adopted");
    adoptedIds = new Set(Array.isArray(stored) ? stored.filter((id) => Number.isInteger(id)) : []);
  }
  return adoptedIds;
}

async function adopt(tabId) {
  const ids = await adopted();
  ids.add(tabId);
  await chrome.storage.session.set({ adopted: [...ids].slice(-100) });
}

async function isMarleyTab(tab) {
  if (!tab) return false;
  if ((await adopted()).has(tab.id)) return true;
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false;
  try {
    return (await chrome.tabGroups.get(tab.groupId)).title === GROUP_TITLE;
  } catch {
    return false;
  }
}

// A window.open popup has no openerTabId in Chrome (found in the end-to-end test), so the navigation that created it names its source instead.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const source = await chrome.tabs.get(details.sourceTabId).catch(() => null);
  if (source && (await isMarleyTab(source))) await adopt(details.tabId);
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.openerTabId !== "number") return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (opener && (await isMarleyTab(opener))) await adopt(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ids = await adopted();
  if (ids.delete(tabId)) await chrome.storage.session.set({ adopted: [...ids] });
});

async function marleyTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw codeError("tab-not-found", `Tab ${tabId} does not exist`);
  }
  if (!(await isMarleyTab(tab))) throw codeError("tab-not-in-group", `Tab ${tabId} is not in the ${GROUP_TITLE} tab group`);
  return tab;
}

function describeTab(tab) {
  return { tabId: tab.id, url: tab.url ?? tab.pendingUrl ?? "", title: tab.title ?? "", active: tab.active, loading: tab.status === "loading", windowId: tab.windowId };
}

async function addToGroup(tabId) {
  const [group] = await marleyGroups();
  if (group) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
}

async function targetWindowId() {
  const [group] = await marleyGroups();
  if (group) return group.windowId;
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return window.id;
  } catch {
    return undefined;
  }
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const finish = (timedOut) => {
      clearTimeout(timer);
      clearTimeout(settle);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ timedOut });
    };
    const listener = (updatedId, change) => {
      if (updatedId !== tabId) return;
      if (change.status === "loading") sawLoading = true;
      if (change.status === "complete" && sawLoading) finish(false);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(true), timeoutMs);
    const settle = setTimeout(async () => {
      if (sawLoading) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status === "complete") finish(false);
    }, 1500);
  });
}

// ---------- debugger ----------

chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!String(error?.message).includes("already attached")) {
      throw codeError("debugger-refused", `Cannot control this tab: ${error?.message ?? error}`);
    }
  }
  attached.add(tabId);
  // A background tab is hidden and renders no frames, so mouse input waits 5 s or hangs.
  // Focus emulation plus an active lifecycle lets Marley work in a tab the user is not looking at.
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" }).catch(() => {});
}

async function cdp(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    if (String(error?.message).includes("not attached")) {
      attached.delete(tabId);
      await ensureDebugger(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw error;
  }
}

async function inPage(tabId, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page error";
    const stale = /stale-ref: (.*)/.exec(message);
    if (stale) throw codeError("stale-ref", stale[1].split("\n")[0]);
    throw codeError("page-error", message.split("\n")[0]);
  }
  return result.result?.value;
}

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

async function pressKey(tabId, key, modifiers = []) {
  let spec = KEYS[key];
  if (!spec) {
    if ([...key].length !== 1) throw codeError("invalid-request", `Unknown key ${key}`);
    const upper = key.toUpperCase();
    const code = /[a-z]/i.test(key) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : undefined;
    spec = { code, keyCode: upper.charCodeAt(0), text: key };
  }
  const bits = modifiers.reduce((sum, name) => sum | (MODIFIER_BITS[name] ?? 0), 0);
  const withText = spec.text && !(bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta));
  const base = { key: spec.key ?? key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: bits };
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: withText ? "keyDown" : "rawKeyDown", ...(withText ? { text: spec.text, unmodifiedText: spec.text } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function clickAt(tabId, x, y, clickCount = 1) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- held secret ----------
// A key the owner asked Marley to move (from a vendor page into a connector form) is read inside this extension and held here for ten minutes:
// in this worker's memory and chrome.storage.session (memory only, never on disk, not reachable from pages). Nothing returns it: copy answers
// with its length, paste with "pasted", and every answer is scrubbed of the held value before it leaves (scrub).
const SECRET_TTL_MS = 10 * 60 * 1000;
let heldSecret = null;

async function held() {
  if (!heldSecret) {
    const { secret } = await chrome.storage.session.get("secret");
    if (secret && typeof secret.value === "string") heldSecret = secret;
  }
  if (heldSecret && Date.now() > heldSecret.expiresAt) {
    heldSecret = null;
    await chrome.storage.session.remove("secret");
  }
  return heldSecret;
}

async function holdSecret(value) {
  heldSecret = { value, expiresAt: Date.now() + SECRET_TTL_MS };
  await chrome.storage.session.set({ secret: heldSecret });
}

/** Every string of an answer with the held value replaced (screenshot pixels are handled by blurSecrets and by refusing a picture while a key is held). */
async function scrub(result) {
  const secret = await held();
  if (!secret) return result;
  const replace = (value) => {
    if (typeof value === "string") return value.includes(secret.value) ? value.split(secret.value).join("(hidden secret)") : value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "data" ? entry : replace(entry)]));
    return value;
  };
  return replace(result);
}

// ---------- handlers ----------

const HANDLERS = {
  async "tabs.list"() {
    const groups = await marleyGroups();
    const ids = new Set(groups.map((group) => group.id));
    const open = new Set(await adopted());
    const windows = new Map((await chrome.windows.getAll()).map((window) => [window.id, window.type]));
    const tabs = (await chrome.tabs.query({})).filter((tab) => ids.has(tab.groupId) || open.has(tab.id));
    return { group: GROUP_TITLE, tabs: tabs.map((tab) => ({ ...describeTab(tab), windowType: windows.get(tab.windowId) ?? "normal", ...(open.has(tab.id) ? { openedByMarleyTab: true } : {}) })) };
  },

  async "tabs.open"({ url, active = false }) {
    const windowId = await targetWindowId();
    let tab;
    if (windowId === undefined) {
      const window = await chrome.windows.create({ url, focused: active });
      tab = window.tabs[0];
    } else {
      tab = await chrome.tabs.create({ url, active, windowId });
    }
    await addToGroup(tab.id);
    const load = await waitForLoad(tab.id, 45000);
    return { ...describeTab(await chrome.tabs.get(tab.id)), loadTimedOut: load.timedOut };
  },

  async "tabs.navigate"({ tabId, url }) {
    await marleyTab(tabId);
    const loaded = waitForLoad(tabId, 45000);
    if (url === "back") await chrome.tabs.goBack(tabId);
    else if (url === "forward") await chrome.tabs.goForward(tabId);
    else if (url === "reload") await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url });
    const load = await loaded;
    return { ...describeTab(await chrome.tabs.get(tabId)), loadTimedOut: load.timedOut };
  },

  async "tabs.focus"({ tabId }) {
    const tab = await marleyTab(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return describeTab(await chrome.tabs.get(tabId));
  },

  async "tabs.close"({ tabId }) {
    await marleyTab(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: true, tabId };
  },

  async snapshot({ tabId, maxText = 6000, maxElements = 200 }) {
    await marleyTab(tabId);
    return { tabId, ...(await inPage(tabId, snapshotPage, maxText, maxElements)) };
  },

  async screenshot({ tabId }) {
    await marleyTab(tabId);
    const metrics = await cdp(tabId, "Page.getLayoutMetrics");
    const shot = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
    return { tabId, data: shot.data, width: Math.round(viewport.clientWidth), height: Math.round(viewport.clientHeight) };
  },

  async click({ tabId, ref, x, y, clickCount = 1 }) {
    await marleyTab(tabId);
    let point = { x, y };
    if (ref) point = await inPage(tabId, locateRef, ref);
    else if (typeof x !== "number" || typeof y !== "number") throw codeError("invalid-request", "click needs ref or x and y");
    await clickAt(tabId, point.x, point.y, clickCount);
    await sleep(150);
    const tab = await chrome.tabs.get(tabId);
    return { clicked: true, x: Math.round(point.x), y: Math.round(point.y), covered: point.covered ?? false, coveredBy: point.coveredBy, url: tab.url, loading: tab.status === "loading" };
  },

  async type({ tabId, ref, text, clear = false, submit = false }) {
    await marleyTab(tabId);
    if (ref) {
      const point = await inPage(tabId, locateRef, ref);
      await clickAt(tabId, point.x, point.y, 1);
    }
    if (clear) {
      await inPage(tabId, selectFocusedContent);
      if (!text) await pressKey(tabId, "Backspace");
    }
    if (text) await cdp(tabId, "Input.insertText", { text });
    if (submit) await pressKey(tabId, "Enter");
    await sleep(100);
    return { typed: true, ...(await inPage(tabId, readFocused).catch(() => ({}))) };
  },

  async key({ tabId, key, modifiers = [] }) {
    await marleyTab(tabId);
    await pressKey(tabId, key, modifiers);
    return { pressed: key };
  },

  async scroll({ tabId, ref, dx = 0, dy = 0 }) {
    await marleyTab(tabId);
    if (ref) {
      await inPage(tabId, locateRef, ref);
    } else {
      const metrics = await cdp(tabId, "Page.getLayoutMetrics");
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: viewport.clientWidth / 2, y: viewport.clientHeight / 2, deltaX: dx, deltaY: dy });
      await sleep(250);
    }
    return { scrolled: true, ...(await inPage(tabId, () => ({ x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight }))) };
  },

  async wait({ tabId, text, ms, timeoutMs = 15000 }) {
    await marleyTab(tabId);
    if (ms) await sleep(ms);
    if (!text) return { waited: ms ?? 0 };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await inPage(tabId, pageHasText, text).catch(() => false)) return { found: true };
      if (Date.now() > deadline) return { found: false };
      await sleep(300);
    }
  },


  async "secret.copy"({ tabId, ref, toClipboard = false }) {
    await marleyTab(tabId);
    if (typeof ref !== "string" || !/^e[0-9]{1,5}$/.test(ref)) throw codeError("invalid-request", "secret.copy needs the ref of the element that shows the key");
    const read = await inPage(tabId, readSecretSource, ref);
    if (read.error === "secret-field") throw codeError("secret-field", "That is a password or code field of the owner. Marley does not copy those.");
    if (read.error) throw codeError("not-a-key", `That element does not hold one key (it holds ${read.chars ?? 0} characters, or several words). Take a snapshot and pick the element that shows only the key.`);
    await holdSecret(read.value);
    const clipboard = toClipboard === true ? await inPage(tabId, writeClipboard, read.value).catch(() => false) : false;
    return { copied: true, chars: read.value.length, clipboard: Boolean(clipboard), heldForSeconds: SECRET_TTL_MS / 1000 };
  },

  async "secret.paste"({ tabId, ref }) {
    await marleyTab(tabId);
    const secret = await held();
    if (!secret) throw codeError("no-secret", "No key is held (none was copied, or the ten minutes ran out). Copy it again from the page that shows it.");
    if (typeof ref !== "string" || !/^e[0-9]{1,5}$/.test(ref)) throw codeError("invalid-request", "secret.paste needs the ref of the field");
    const tab = await chrome.tabs.get(tabId);
    if (!/^https:\/\//.test(tab.url ?? "")) throw codeError("insecure-page", "A key is pasted only into a page on https.");
    const done = await inPage(tabId, pasteSecret, ref, secret.value);
    if (done.error) throw codeError(done.error, done.error === "covered" ? `Something covers that field (${done.coveredBy}); take a new snapshot.` : "That element is not a text field Marley can paste into.");
    return { pasted: true, chars: done.chars };
  },

  // store:strip-start (evaluate runs any page script; only the local Marshal socket of a developer install offers it)
  async evaluate({ tabId, expression }) {
    await marleyTab(tabId);
    const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) {
      throw codeError("page-error", (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page error").split("\n")[0]);
    }
    return { value: result.result?.value ?? null, type: result.result?.type };
  },
  // store:strip-end
};

// ---------- Marley cloud (pairing from the Marley site, then one WebSocket to Marley's browser relay) ----------
// The site hands over a pairing token and the relay's address once (chrome.runtime.sendMessage from one of PAIR_ORIGINS, which the
// manifest's externally_connectable also limits). The extension keeps one WebSocket open to that relay; Marley's steps arrive on it and
// the answers go back on it. Evaluate is never run on this path. The relay sits behind a load balancer that ends a connection after
// about two minutes, so the socket reconnects right away when that happens.

// Staging and the local web app pair only a developer (unpacked) install; a store install pairs with production alone.
const PAIR_ORIGINS = DEVELOPER_INSTALL ? ["https://app.marleyagent.com", "https://app-staging.marley.zygedge.com", "http://localhost:3107"] : ["https://app.marleyagent.com"];
const MAX_SHOT_CHARS = 5_000_000;
const CLOUD_METHODS = new Set(["tabs.list", "tabs.open", "tabs.navigate", "tabs.focus", "tabs.close", "snapshot", "screenshot", "click", "type", "key", "scroll", "wait", "secret.copy", "secret.paste"]);
const PAIRING_TOKEN = /^mbp1\.[A-Za-z0-9_-]{1,700}\.[A-Za-z0-9_-]{43}$/;
let relay = null;
let relayConnecting = false;
let relayBackoff = 1000;
let cloudState = { status: "unpaired", error: null, lastSeenAt: null };

/** The relay must be on the pairing site's own host (wss), or, for the local web app, a loopback ws address. */
function relayAllowed(origin, relayUrl) {
  try {
    const url = new URL(relayUrl);
    if (url.pathname !== "/browser-relay" || url.search || url.hash || url.username || url.password) return false;
    if (origin === "http://localhost:3107") return url.protocol === "ws:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return url.protocol === "wss:" && url.host === new URL(origin).host;
  } catch {
    return false;
  }
}

async function cloudSettings() {
  const { cloud } = await chrome.storage.local.get("cloud");
  return cloud && PAIR_ORIGINS.includes(cloud.origin) && PAIRING_TOKEN.test(cloud.token) && relayAllowed(cloud.origin, cloud.relayUrl) ? cloud : null;
}

const SECRET_REFUSAL = "This is a password or code field. Ask the owner to type it themselves.";

// `type` on the cloud path: the target is checked, then clicked, then the element that HAS focus is checked again before any text goes in
// (a label, an overlay or a field that turns into a password field on focus would otherwise receive it). Best effort, not a guarantee.
async function cloudType({ tabId, ref, text, clear = false, submit = false }) {
  await marleyTab(tabId);
  if (!ref || (await inPage(tabId, isSecretField, ref))) throw codeError("secret-field", SECRET_REFUSAL);
  const point = await inPage(tabId, locateRef, ref);
  // Typing goes where focus lands: never into a field something covers, or into a frame whose field cannot be checked.
  if (point.covered) throw codeError("covered", `Something covers that field (${point.coveredBy ?? "another element"}); take a new snapshot.`);
  await clickAt(tabId, point.x, point.y, 1);
  await sleep(50);
  if (await inPage(tabId, isSecretField, null)) throw codeError("secret-field", SECRET_REFUSAL);
  if (await inPage(tabId, focusInFrame)) throw codeError("framed-field", "That field is inside an embedded frame Marley cannot check: ask the owner to fill it in themselves.");
  if (clear) {
    await inPage(tabId, selectFocusedContent);
    if (!text) await pressKey(tabId, "Backspace");
  }
  if (text) await cdp(tabId, "Input.insertText", { text });
  if (submit) await pressKey(tabId, "Enter");
  await sleep(100);
  return { typed: true, ...(await inPage(tabId, readFocused).catch(() => ({}))) };
}

// A screenshot the web app can carry (its result limit is 6 MiB): PNG, else JPEG, else a plain refusal instead of an unknown outcome.
async function cloudScreenshot(params) {
  // A picture can show a key the page displays or a form it was pasted into: none while one is held, and words that look like a key are blurred.
  if (await held()) throw codeError("secret-held", "A key is being moved right now; no pictures until it is pasted or ten minutes passed. Use a snapshot.");
  await marleyTab(params.tabId);
  await inPage(params.tabId, blurSecrets).catch(() => {});
  try {
    return await cloudScreenshotBlurred(params);
  } finally {
    await inPage(params.tabId, unblurSecrets).catch(() => {});
  }
}

async function cloudScreenshotBlurred(params) {
  const png = await HANDLERS.screenshot(params);
  if (png.data.length <= MAX_SHOT_CHARS) return { ...png, format: "png" };
  for (const quality of [70, 45]) {
    const jpeg = await cdp(params.tabId, "Page.captureScreenshot", { format: "jpeg", quality });
    if (jpeg.data.length <= MAX_SHOT_CHARS) return { ...png, data: jpeg.data, format: "jpeg" };
  }
  throw codeError("screenshot-too-large", "The page is too large to capture; take a snapshot instead.");
}

async function runCloudCommand(cloud, command) {
  let body;
  try {
    // The owner may have switched Marley off, or unpaired, while this step was on its way: it is refused, never run.
    const [{ enabled }, current] = await Promise.all([settings(), cloudSettings()]);
    if (!enabled || current?.token !== cloud.token) throw codeError("browser-off", "The owner switched off Marley's use of this browser.");
    if (!CLOUD_METHODS.has(command.method)) throw codeError("unknown-method", `Marley cannot run ${command.method} here`);
    // Marley never types a secret: the owner signs in and enters codes themselves (the prompt hands the tab to them).
    const params = command.params ?? {};
    const result = command.method === "type" ? await cloudType(params) : command.method === "screenshot" ? await cloudScreenshot(params) : null;
    if (command.method === "key" && [...String(params.key ?? "")].length === 1 && ((await inPage(params.tabId, isSecretField, null)) || (await inPage(params.tabId, focusInFrame)))) throw codeError("secret-field", SECRET_REFUSAL);
    body = { type: "result", id: command.id, ok: true, result: await scrub(result ?? (await HANDLERS[command.method](params))) };
  } catch (error) {
    body = { type: "result", id: command.id, ok: false, error: { code: error.code ?? "browser-error", message: String(error.message ?? error) } };
  }
  if (relay?.readyState === WebSocket.OPEN) relay.send(JSON.stringify(body));
}

function relayClosed(status, error) {
  relay = null;
  cloudState = { status, error, lastSeenAt: cloudState.lastSeenAt };
  updateBadge();
}

async function cloudConnect() {
  if (relayConnecting || relay) return;
  const { enabled } = await settings();
  const cloud = await cloudSettings();
  if (!enabled || !cloud) {
    cloudState = { status: cloud ? "off" : "unpaired", error: cloudState.error, lastSeenAt: cloudState.lastSeenAt };
    updateBadge();
    return;
  }
  relayConnecting = true;
  let ws;
  try {
    ws = new WebSocket(cloud.relayUrl);
  } catch (error) {
    relayConnecting = false;
    relayClosed("waiting", String(error?.message ?? error));
    return;
  }
  relay = ws;
  ws.onopen = () => {
    relayConnecting = false;
    ws.send(JSON.stringify({ type: "hello", token: cloud.token, version: chrome.runtime.getManifest().version }));
  };
  ws.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    cloudState = { ...cloudState, lastSeenAt: Date.now() };
    if (message.type === "ready") {
      relayBackoff = 1000;
      cloudState = { status: "connected", error: null, lastSeenAt: Date.now() };
      updateBadge();
    } else if (message.type === "step" && typeof message.id === "string") {
      runCloudCommand(cloud, message);
    }
  };
  ws.onclose = async (event) => {
    relayConnecting = false;
    if (relay !== ws) return;
    // 4401 / 4403: the relay no longer takes this pairing (another person owns the brand now, or a broken token); 4409: paired elsewhere.
    if (event.code === 4401 || event.code === 4403 || event.code === 4409) {
      await chrome.storage.local.remove("cloud");
      relayClosed("unpaired", event.code === 4409 ? "Marley was paired with another Chrome. Pair again from the Marley site to use this one." : "Marley no longer accepts this pairing. Pair again from the Marley site.");
      return;
    }
    relayClosed("waiting", event.code === 1000 || event.code === 1001 || event.code === 1006 ? null : `closed (${event.code})`);
    // The load balancer ends every connection after a while: a connection that reached ready reset the backoff, so it is back in a second.
    const delay = relayBackoff;
    relayBackoff = Math.min(relayBackoff * 2, 30000);
    setTimeout(cloudConnect, delay);
  };
  ws.onerror = () => {};
}

function cloudDisconnect() {
  const ws = relay;
  relay = null;
  relayConnecting = false;
  if (ws) ws.close(1000, "switched off");
}

// Chrome keeps the service worker alive while the socket carries traffic; a ping every 20 s is that traffic.
setInterval(() => { if (relay?.readyState === WebSocket.OPEN) relay.send(JSON.stringify({ type: "ping" })); }, 20000);

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  if (!PAIR_ORIGINS.includes(origin)) return false;
  (async () => {
    if (message?.type === "marley-ping") {
      const cloud = await cloudSettings();
      sendResponse({ installed: true, version: chrome.runtime.getManifest().version, paired: cloud?.origin === origin ? { brandName: cloud.brandName, status: cloudState.status } : null });
    } else if (message?.type === "marley-pair" && PAIRING_TOKEN.test(message.token ?? "") && relayAllowed(origin, message.relayUrl ?? "")) {
      // The storage change below closes any old socket and connects with the new pairing (chrome.storage.onChanged).
      await chrome.storage.local.set({ cloud: { origin, token: message.token, relayUrl: message.relayUrl, brandName: String(message.brandName ?? "").slice(0, 120), pairedAt: Date.now() }, enabled: true });
      sendResponse({ ok: true });
    } else if (message?.type === "marley-unpair") {
      const cloud = await cloudSettings();
      if (cloud?.origin === origin) { cloudDisconnect(); await chrome.storage.local.remove("cloud"); }
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
  })();
  return true;
});

// ---------- lifecycle ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "unpair") {
    cloudDisconnect();
    chrome.storage.local.remove("cloud").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type !== "getState") return false;
  (async () => {
    const { enabled, bridgeUrl } = await settings();
    const { tabs } = await HANDLERS["tabs.list"]();
    const cloud = await cloudSettings();
    sendResponse({ enabled, bridgeUrl, connected: socket?.readyState === WebSocket.OPEN, lastError, tabs, cloud: cloud ? { origin: cloud.origin, brandName: cloud.brandName, ...cloudState } : { status: "unpaired", error: cloudState.error } });
  })();
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.bridgeUrl) disconnect();
  if (changes.enabled?.newValue === false || (changes.cloud && changes.cloud.newValue?.token !== changes.cloud.oldValue?.token)) cloudDisconnect();
  connect();
  cloudConnect();
});

function wake() {
  connect();
  cloudConnect();
}

chrome.alarms.create("marley-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === "marley-keepalive" && wake());
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);
wake();

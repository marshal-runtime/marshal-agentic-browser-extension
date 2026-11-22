// Functions evaluated inside the page through the debugger (Runtime.evaluate).
// Each one is serialized with toString(), so it must not use anything outside itself.

export function snapshotPage(maxText, maxElements) {
  const state = (window.__marley ??= { next: 1, byElement: new WeakMap(), byRef: new Map() });
  const selector = [
    "a[href]", "button", "input", "select", "textarea", "summary", "label[for]",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=option]", "[role=switch]", "[role=combobox]",
    "[role=textbox]", "[role=searchbox]", "[role=slider]", "[role=treeitem]",
    "[contenteditable='']", "[contenteditable='true']", "[tabindex]:not([tabindex='-1'])", "[onclick]",
  ].join(",");
  // A key or token never comes back in a snapshot: a long, random-looking word is replaced by a marker (a shape rule, not a list of words).
  // The same rule lives in maskSecretShapes, blurSecrets and readFocused: each page function is serialized on its own.
  const entropy = (word) => {
    const counts = new Map();
    for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) bits -= (count / word.length) * Math.log2(count / word.length);
    return bits;
  };
  const looksSecret = (word) => word.length >= 20 && /[0-9]/.test(word) && /[A-Za-z]/.test(word) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(word) && entropy(word) >= 3.8;
  const mask = (text) => String(text).replace(/[A-Za-z0-9_-]{20,}/g, (word) => (looksSecret(word) ? "(hidden secret)" : word));
  const clean = (text, max = 120) => mask(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, max);
  const found = [];
  const seen = new Set();
  const walk = (root) => {
    for (const element of root.querySelectorAll(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        found.push(element);
      }
    }
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) walk(element.shadowRoot);
  };
  walk(document);

  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "label") return "label";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "generic";
  };
  const nameOf = (element) => {
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ");
      if (clean(text)) return clean(text);
    }
    if (element.labels?.length) {
      const text = [...element.labels].map((label) => label.innerText).join(" ");
      if (clean(text)) return clean(text);
    }
    const text = element.innerText || element.getAttribute("placeholder") || element.getAttribute("title") || element.getAttribute("alt");
    if (clean(text)) return clean(text);
    if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type)) return clean(element.value);
    return clean(element.getAttribute("name") || element.id);
  };

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const items = [];
  for (const element of found) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    let ref = state.byElement.get(element);
    if (!ref) {
      ref = `e${state.next++}`;
      state.byElement.set(element, ref);
    }
    state.byRef.set(ref, new WeakRef(element));
    const tag = element.tagName.toLowerCase();
    const item = {
      ref,
      role: element.getAttribute("role") || implicitRole(element),
      name: nameOf(element),
      tag,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width,
      x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height),
    };
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (element.type || "").toLowerCase();
      if (type) item.type = type;
      if (type === "checkbox" || type === "radio") item.checked = element.checked;
      else {
        // The same rule as isSecretField (inlined: each page function runs on its own): a code the owner typed never comes back in a snapshot.
        const labels = [...(element.labels ?? [])].map((label) => label.innerText).join(" ");
        const words = `${element.name ?? ""} ${element.id ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.placeholder ?? ""} ${labels}`.toLowerCase();
        const secret = type === "password" || /one-time-code|current-password|new-password/.test((element.getAttribute("autocomplete") ?? "").toLowerCase())
          || (tag === "input" && /passw|passcode|\botp\b|2fa|mfa|totp|\bpin\b|(^|[\s_-])code\b|verification|security code|recovery|one.?time|approvals?_code/.test(words));
        item.value = secret || state.pasted?.has(element) ? (element.value ? "(hidden)" : "") : clean(element.value, 300);
      }
      if (element.placeholder) item.placeholder = clean(element.placeholder);
    }
    if (element.disabled || element.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (tag === "a") item.href = element.href;
    const expanded = element.getAttribute("aria-expanded");
    if (expanded) item.expanded = expanded === "true";
    items.push(item);
  }
  items.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));
  const elements = items.slice(0, maxElements);

  const fullText = mask((document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim());
  return {
    url: location.href,
    title: document.title,
    viewport,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
    text: fullText.slice(0, maxText),
    textTruncated: fullText.length > maxText,
    elements,
    elementsTruncated: items.length > elements.length,
  };
}

export function locateRef(ref) {
  const element = window.__marley?.byRef.get(ref)?.deref();
  if (!element || !element.isConnected) {
    throw new Error(`stale-ref: ${ref} is not on the page any more; take a new snapshot`);
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  const covered = Boolean(top && top !== element && !element.contains(top) && !top.contains(element));
  return { x, y, covered, coveredBy: covered ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ""}` : undefined };
}

export function selectFocusedContent() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element) return false;
  if (typeof element.select === "function" && (element.tagName === "INPUT" || element.tagName === "TEXTAREA")) {
    element.select();
    return true;
  }
  if (element.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}

export function readFocused() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element || element === document.body) return { focused: null };
  const type = (element.type || "").toLowerCase();
  const value = element.isContentEditable ? element.innerText : element.value;
  // Same shape rule as snapshotPage: a key that was pasted or typed never comes back.
  const entropy = (word) => {
    const counts = new Map();
    for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) bits -= (count / word.length) * Math.log2(count / word.length);
    return bits;
  };
  const looksSecret = (word) => word.length >= 20 && /[0-9]/.test(word) && /[A-Za-z]/.test(word) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(word) && entropy(word) >= 3.8;
  const mask = (text) => String(text).replace(/[A-Za-z0-9_-]{20,}/g, (word) => (looksSecret(word) ? "(hidden secret)" : word));
  const pasted = window.__marley?.pasted?.has(element);
  return {
    focused: element.tagName.toLowerCase(),
    value: type === "password" || pasted ? (value ? "(hidden)" : "") : mask(String(value ?? "").slice(0, 300)),
  };
}

export function pageHasText(text) {
  return (document.body?.innerText ?? "").includes(text);
}

/**
 * Whether the element of `ref` (or, with no ref, the focused element, through shadow roots) is a field for a secret: a password, a one-time,
 * 2-step, verification or recovery code, a PIN. A best-effort check by type, autocomplete and the words naming the field; the cloud path runs it
 * on the focused element after its click too, so a label or an overlay that moves focus onto such a field is caught.
 */
/** Whether focus is inside an embedded frame (through shadow roots): the secret-field check cannot see that frame's field. */
export function focusInFrame() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element?.tagName === "IFRAME" || element?.tagName === "FRAME";
}

export function isSecretField(ref) {
  let element = ref ? window.__marley?.byRef.get(ref)?.deref() : document.activeElement;
  while (!ref && element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element?.tagName === "LABEL" && element.control) element = element.control;
  if (!element || element.tagName !== "INPUT") return false;
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  const labels = [...(element.labels ?? [])].map((label) => label.innerText).join(" ");
  const words = `${element.name ?? ""} ${element.id ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.placeholder ?? ""} ${labels}`.toLowerCase();
  return type === "password" || /one-time-code|current-password|new-password/.test(autocomplete)
    || /passw|passcode|\botp\b|2fa|mfa|totp|\bpin\b|(^|[\s_-])code\b|verification|security code|recovery|one.?time|approvals?_code/.test(words);
}

/**
 * The text of the element of `ref`, for secret.copy: a key the page shows (in a field or as text) is read inside the extension and held there; it is
 * returned to the extension's own code only, and the extension never sends it on. Refused for a password or code field (the owner's own secrets),
 * and for anything that is not one single word of 8 to 512 characters (a paragraph, an address, a name).
 */
export function readSecretSource(ref) {
  const element = window.__marley?.byRef.get(ref)?.deref();
  if (!element || !element.isConnected) throw new Error(`stale-ref: ${ref} is not on the page any more; take a new snapshot`);
  const target = element.tagName === "LABEL" && element.control ? element.control : element;
  if (target.tagName === "INPUT") {
    const type = (target.getAttribute("type") ?? "").toLowerCase();
    const autocomplete = (target.getAttribute("autocomplete") ?? "").toLowerCase();
    const labels = [...(target.labels ?? [])].map((label) => label.innerText).join(" ");
    const words = `${target.name ?? ""} ${target.id ?? ""} ${target.getAttribute("aria-label") ?? ""} ${target.placeholder ?? ""} ${labels}`.toLowerCase();
    const owners = type === "password" || /one-time-code|current-password|new-password/.test(autocomplete)
      || /passw|passcode|\botp\b|2fa|mfa|totp|\bpin\b|(^|[\s_-])code\b|verification|security code|recovery|one.?time|approvals?_code/.test(words);
    if (owners) return { error: "secret-field" };
  }
  const raw = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" ? target.value : target.innerText ?? target.textContent;
  const value = String(raw ?? "").trim();
  if (!/^\S{8,512}$/.test(value)) return { error: "not-a-key", chars: value.length };
  return { value };
}

/** Puts a held key into the field of `ref` the way typing would (native setter, input and change events), and remembers the field so no snapshot shows it. */
export function pasteSecret(ref, value) {
  const element = window.__marley?.byRef.get(ref)?.deref();
  if (!element || !element.isConnected) throw new Error(`stale-ref: ${ref} is not on the page any more; take a new snapshot`);
  const tag = element.tagName;
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  const fillable = tag === "TEXTAREA" || (tag === "INPUT" && ["text", "password", "search", "url", "tel", "email", ""].includes(type));
  if (!fillable) return { error: "not-a-text-field" };
  if (element.disabled || element.readOnly) return { error: "field-not-editable" };
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (top && top !== element && !element.contains(top) && !top.contains(element)) return { error: "covered", coveredBy: top.tagName.toLowerCase() };
  element.focus();
  const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  const state = (window.__marley ??= { next: 1, byElement: new WeakMap(), byRef: new Map() });
  (state.pasted ??= new WeakSet()).add(element);
  return { chars: value.length };
}

/** A key the page shows must not be on a screenshot: every word that looks like one, and every field a key was pasted into, is blurred until unblurSecrets. */
export function blurSecrets() {
  const entropy = (word) => {
    const counts = new Map();
    for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) bits -= (count / word.length) * Math.log2(count / word.length);
    return bits;
  };
  const looksSecret = (word) => word.length >= 20 && /[0-9]/.test(word) && /[A-Za-z]/.test(word) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(word) && entropy(word) >= 3.8;
  const hasSecret = (text) => (String(text).match(/[A-Za-z0-9_-]{20,}/g) ?? []).some(looksSecret);
  const saved = (window.__marleyBlurred ??= []);
  const blur = (element) => {
    if (!element || saved.some((entry) => entry.element === element)) return;
    saved.push({ element, filter: element.style.filter });
    element.style.setProperty("filter", "blur(10px)", "important");
  };
  const walk = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (hasSecret(node.nodeValue)) blur(node.parentElement);
    for (const field of root.querySelectorAll("input, textarea")) {
      if (window.__marley?.pasted?.has(field) || hasSecret(field.value)) blur(field);
    }
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) walk(element.shadowRoot);
  };
  walk(document.body ?? document);
  return { blurred: saved.length };
}

export function unblurSecrets() {
  for (const { element, filter } of window.__marleyBlurred ?? []) {
    if (filter) element.style.filter = filter;
    else element.style.removeProperty("filter");
  }
  window.__marleyBlurred = [];
}

/** Puts the held key on the system clipboard from the page it came from (so the owner can also paste it by hand). True when it worked. */
export async function writeClipboard(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  }
}

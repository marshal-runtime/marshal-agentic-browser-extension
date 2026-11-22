const dot = document.getElementById("dot");
const status = document.getElementById("status");
const enabled = document.getElementById("enabled");
const bridgeUrl = document.getElementById("bridgeUrl");
const tabsBox = document.getElementById("tabs");
const cloudBox = document.getElementById("cloud");
const unpair = document.getElementById("unpair");

async function render() {
  const state = await chrome.runtime.sendMessage({ type: "getState" });
  enabled.checked = state.enabled;
  // The developer field is not in a store build (popup.html store:strip).
  if (bridgeUrl && document.activeElement !== bridgeUrl) bridgeUrl.value = state.bridgeUrl;
  const cloudOn = state.cloud?.status === "connected";
  const live = state.connected || cloudOn;
  dot.className = `dot ${!state.enabled ? "off" : live ? "on" : ""}`;
  status.textContent = !state.enabled
    ? "Off. Marley cannot use this browser."
    : live
      ? "Connected. Marley can work in its tab group."
      : state.cloud?.status === "unpaired" && !state.bridgeUrl
        ? "Not paired yet. Open the link Marley sent you on WhatsApp to pair this Chrome."
        : `Waiting for Marley… ${state.cloud?.error ?? state.lastError ?? ""}`;
  cloudBox.textContent = state.cloud?.brandName ? `Paired with Marley for ${state.cloud.brandName}.` : "";
  unpair.hidden = !state.cloud?.brandName;
  tabsBox.replaceChildren();
  if (state.tabs.length) {
    const list = document.createElement("ul");
    for (const tab of state.tabs) {
      const item = document.createElement("li");
      item.textContent = tab.title || tab.url;
      item.title = tab.url;
      list.append(item);
    }
    tabsBox.append(list);
  }
}

enabled.addEventListener("change", () => chrome.storage.local.set({ enabled: enabled.checked }).then(render));
bridgeUrl?.addEventListener("change", () => chrome.storage.local.set({ bridgeUrl: bridgeUrl.value.trim() }).then(render));
unpair.addEventListener("click", () => chrome.runtime.sendMessage({ type: "unpair" }).then(render));
render();
setInterval(render, 1500);

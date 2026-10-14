import { DEFAULT_BRIDGE_PORT, describeMedia, formatBytes, type MediaItem } from "@turbodl/shared";
import { getMedia } from "./media-store";
import type { ExtensionMessage, MessageReply } from "./messages";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: ExtensionMessage) => chrome.runtime.sendMessage(msg) as Promise<MessageReply>;

async function refreshStatus(): Promise<void> {
  const status = byId<HTMLSpanElement>("status");
  status.textContent = "Checking…";
  status.className = "status";
  const { ok } = await send({ type: "status" });
  status.textContent = ok ? "Connected" : "App not running";
  status.className = `status ${ok ? "ok" : "bad"}`;
  byId<HTMLButtonElement>("launch").hidden = ok;
}

function renderItem(item: MediaItem, tab: chrome.tabs.Tab): HTMLLIElement {
  const li = document.createElement("li");
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = item.size ? `${describeMedia(item)} · ${formatBytes(item.size)}` : describeMedia(item);
  const url = document.createElement("span");
  url.className = "url";
  url.textContent = item.url;
  url.title = item.url;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const { ok } = await send({ type: "send-media-item", pageUrl: tab.url ?? item.url, title: tab.title ?? "", item });
    button.textContent = ok ? "✓" : "Error";
  });
  li.append(kind, button, url);
  return li;
}

async function init(): Promise<void> {
  const capture = byId<HTMLInputElement>("capture");
  const port = byId<HTMLInputElement>("port");
  const stored = await chrome.storage.local.get(["captureOn", "port"]);
  capture.checked = stored.captureOn !== false;
  port.value = String(typeof stored.port === "number" ? stored.port : DEFAULT_BRIDGE_PORT);
  capture.addEventListener("change", () => {
    void chrome.storage.local.set({ captureOn: capture.checked });
  });
  port.addEventListener("change", async () => {
    const n = Number(port.value);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
      await chrome.storage.local.set({ port: n });
      await refreshStatus();
    }
  });
  void refreshStatus();

  const launch = byId<HTMLButtonElement>("launch");
  launch.addEventListener("click", async () => {
    launch.disabled = true;
    launch.textContent = "Starting…";
    byId<HTMLParagraphElement>("launch-error").hidden = true;
    const { ok } = await send({ type: "launch" });
    launch.disabled = false;
    launch.textContent = "Start TurboDL";
    byId<HTMLParagraphElement>("launch-error").hidden = ok;
    await refreshStatus();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const list = byId<HTMLUListElement>("media");
  const items = tab?.id !== undefined ? await getMedia(tab.id) : [];
  byId<HTMLParagraphElement>("empty").hidden = items.length > 0;
  if (tab) for (const item of [...items].reverse()) list.appendChild(renderItem(item, tab));

  const analyze = byId<HTMLButtonElement>("analyze");
  analyze.disabled = !tab?.url || !/^https?:/i.test(tab.url);
  analyze.addEventListener("click", async () => {
    if (!tab?.url) return;
    analyze.disabled = true;
    analyze.textContent = "Sending…";
    const { ok } = await send({ type: "media-request", tabId: tab.id, pageUrl: tab.url, title: tab.title ?? "" });
    analyze.textContent = ok ? "Opened in TurboDL ✓" : "TurboDL is not running";
  });
}

void init();

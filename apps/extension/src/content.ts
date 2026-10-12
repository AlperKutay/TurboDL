import type { ExtensionMessage, MessageReply } from "./messages";

const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const LABEL = "⬇ TurboDL";
let button: HTMLButtonElement | null = null;
let current: HTMLVideoElement | null = null;
let hideTimer = 0;
let lastCheck = 0;

const STYLE = `
  button {
    position: fixed; display: none; padding: 7px 12px; border: 0; border-radius: 8px;
    background: linear-gradient(135deg, #3b6cf6, #7c3aed); color: #fff; cursor: pointer;
    font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); opacity: 0.95; white-space: nowrap;
  }
  button:hover { opacity: 1; filter: brightness(1.08); }
`;

function ensureButton(): HTMLButtonElement {
  if (button) return button;
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = LABEL;
  root.append(style, b);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void send();
  });
  b.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  b.addEventListener("mouseleave", scheduleHide);
  (document.body ?? document.documentElement).appendChild(host);
  button = b;
  return b;
}

function videoAt(x: number, y: number): HTMLVideoElement | null {
  const videos = document.getElementsByTagName("video");
  for (let i = 0; i < videos.length; i++) {
    const r = videos[i].getBoundingClientRect();
    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return videos[i];
  }
  return null;
}

function place(video: HTMLVideoElement): void {
  const b = ensureButton();
  b.style.display = "block";
  const r = video.getBoundingClientRect();
  b.style.top = `${Math.max(4, r.top + 10)}px`;
  b.style.left = `${Math.max(4, r.right - b.offsetWidth - 10)}px`;
  current = video;
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (button) button.style.display = "none";
  }, 2500);
}

async function send(): Promise<void> {
  const b = ensureButton();
  b.textContent = "Sending…";
  const src = current?.currentSrc || current?.src || undefined;
  const msg: ExtensionMessage = { type: "media-request", pageUrl: location.href, title: document.title, srcUrl: src };
  try {
    const reply = (await chrome.runtime.sendMessage(msg)) as MessageReply | undefined;
    b.textContent = reply?.ok ? "✓ Sent" : "TurboDL is not running";
  } catch {
    b.textContent = "Reload the page";
  }
  window.setTimeout(() => {
    b.textContent = LABEL;
  }, 2500);
}

document.addEventListener(
  "mousemove",
  (e) => {
    const now = performance.now();
    if (now - lastCheck < 80) return;
    lastCheck = now;
    const video = videoAt(e.clientX, e.clientY);
    if (video) {
      place(video);
      scheduleHide();
    }
  },
  { passive: true, capture: true },
);

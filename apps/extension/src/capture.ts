import { captureDecision, type CaptureCandidate } from "@turbodl/shared";
import { getConfig, rememberedConfig, sendDownload } from "./bridge";
import { basename } from "./headers";
import { ensureApp } from "./launcher";
import { cookieHeader, flashBadge } from "./util";

const WAIT_FOR_NAME_MS = 3000;
const waiting = new Map<number, ReturnType<typeof setTimeout>>();
const handled = new Set<number>();

async function captureOn(): Promise<boolean> {
  const { captureOn } = await chrome.storage.local.get("captureOn");
  return captureOn !== false;
}

function candidateOf(item: chrome.downloads.DownloadItem): CaptureCandidate {
  const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : undefined;
  return {
    url: item.finalUrl || item.url,
    filename: item.filename ? basename(item.filename) : undefined,
    mime: item.mime || undefined,
    fileSize: size,
    byExtensionId: item.byExtensionId,
  };
}

async function evaluate(item: chrome.downloads.DownloadItem, filenameKnown: boolean): Promise<void> {
  if (handled.has(item.id) || item.state !== "in_progress") return;
  if (!(await captureOn())) return;
  const config = (await getConfig()) ?? (await rememberedConfig());
  if (!config) return;
  const candidate = candidateOf(item);
  const decision = captureDecision(candidate, {
    enabled: config.captureEnabled,
    extensions: config.captureExtensions,
    minSize: config.minCaptureSize,
    selfExtensionId: chrome.runtime.id,
  });
  if (decision === "skip") return;
  if (decision === "undecided") {
    if (filenameKnown || waiting.has(item.id)) return;
    waiting.set(item.id, setTimeout(() => waiting.delete(item.id), WAIT_FOR_NAME_MS));
    // the name may have been decided while we were waiting for the config
    const [latest] = await chrome.downloads.search({ id: item.id });
    if (latest?.filename) {
      clearTimeout(waiting.get(item.id));
      waiting.delete(item.id);
      await evaluate(latest, true);
    }
    return;
  }
  // re-check: another event for the same download may have claimed it while we awaited the config
  if (handled.has(item.id)) return;
  handled.add(item.id);
  await capture(item, candidate);
}

/** Firefox (the only browser with runtime.getBrowserInfo) cancels a download on pause() instead of holding it. */
function pauseCancels(): boolean {
  return typeof (chrome.runtime as { getBrowserInfo?: unknown }).getBrowserInfo === "function";
}

async function capture(item: chrome.downloads.DownloadItem, candidate: CaptureCandidate): Promise<void> {
  // Chrome holds the download paused while TurboDL takes over; Firefox keeps downloading instead,
  // because its pause would cancel the download and resuming needs a range request the server may refuse
  const hold = !pauseCancels();
  if (hold) {
    try {
      await chrome.downloads.pause(item.id);
    } catch {
      // already finished or not pausable yet
    }
  }
  const [current] = await chrome.downloads.search({ id: item.id });
  if (!current || current.state !== "in_progress") return;
  const giveBack = async () => {
    if (hold) await chrome.downloads.resume(item.id).catch(() => undefined);
    flashBadge();
  };
  // TurboDL may be closed: start it through the native host while the browser's download waits
  if (!(await ensureApp())) return giveBack();
  if (!hold) {
    // the browser kept downloading meanwhile: a download it already finished stays with the browser
    const [now] = await chrome.downloads.search({ id: item.id });
    if (!now || now.state !== "in_progress") return;
  }

  const result = await sendDownload({
    url: item.url,
    referrer: item.referrer || undefined,
    cookies: await cookieHeader(item.url),
    userAgent: navigator.userAgent,
    filename: candidate.filename,
    fileSize: candidate.fileSize,
    mime: candidate.mime,
    source: "intercept",
  });
  if (result.ok) {
    await chrome.downloads.cancel(item.id).catch(() => undefined);
    await chrome.downloads.erase({ id: item.id }).catch(() => undefined);
  } else {
    await giveBack();
  }
}

export function registerCapture(): void {
  chrome.downloads.onCreated.addListener((item) => {
    void evaluate(item, false);
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.filename?.current || !waiting.has(delta.id)) return;
    clearTimeout(waiting.get(delta.id));
    waiting.delete(delta.id);
    void chrome.downloads.search({ id: delta.id }).then(([item]) => {
      if (item) void evaluate(item, true);
    });
  });
}

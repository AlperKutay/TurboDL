import { addMediaItem, type MediaItem } from "@turbodl/shared";

/** A detected media item plus the time its request was made (ms since epoch). */
interface StoredMedia extends MediaItem {
  at: number;
}

const key = (tabId: number) => `media:${tabId}`;
let queue: Promise<void> = Promise.resolve();

async function read(tabId: number): Promise<StoredMedia[]> {
  const stored = await chrome.storage.session.get(key(tabId));
  return (stored[key(tabId)] as StoredMedia[] | undefined) ?? [];
}

async function write(tabId: number, list: StoredMedia[]): Promise<void> {
  if (list.length > 0) await chrome.storage.session.set({ [key(tabId)]: list });
  else await chrome.storage.session.remove(key(tabId));
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#3b6cf6" });
    await chrome.action.setBadgeText({ tabId, text: list.length > 0 ? String(list.length) : "" });
  } catch {
    // the tab is gone
  }
}

/** Serialise all storage updates so concurrent requests do not overwrite each other. */
function enqueue(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job).catch(() => undefined);
  return queue;
}

export async function getMedia(tabId: number): Promise<MediaItem[]> {
  return (await read(tabId)).map(({ at: _at, ...item }) => item);
}

export function addMedia(tabId: number, item: MediaItem, at: number): Promise<void> {
  return enqueue(async () => {
    const list = await read(tabId);
    if (list.some((m) => m.url === item.url && m.size === item.size)) return;
    await write(tabId, addMediaItem(list, { ...item, at }));
  });
}

export function clearMediaBefore(tabId: number, before: number): Promise<void> {
  return enqueue(async () => {
    const list = await read(tabId);
    const kept = list.filter((m) => m.at >= before);
    if (kept.length !== list.length) await write(tabId, kept);
  });
}

export function clearMedia(tabId: number): Promise<void> {
  return enqueue(() => write(tabId, []));
}

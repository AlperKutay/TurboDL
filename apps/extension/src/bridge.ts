import { DEFAULT_BRIDGE_PORT, type BridgeConfig, type DownloadRequest, type MediaRequest, type PingResponse } from "@turbodl/shared";

const CONFIG_TTL = 60_000;
let configCache: { value: BridgeConfig; at: number; port: number } | null = null;

export async function getPort(): Promise<number> {
  const { port } = await chrome.storage.local.get("port");
  return typeof port === "number" && port > 0 ? port : DEFAULT_BRIDGE_PORT;
}

// Always POST: Chrome omits the Origin header on GETs from an extension, and the app requires it.
async function call<T>(path: string, body: unknown = {}, timeoutMs = 4000): Promise<{ status: number; data: T | null }> {
  const port = await getPort();
  const res = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

export async function ping(): Promise<boolean> {
  try {
    const res = await call<PingResponse>("/ping");
    return res.status === 200 && res.data?.app === "turbodl";
  } catch {
    return false;
  }
}

export async function getConfig(): Promise<BridgeConfig | null> {
  const port = await getPort();
  if (configCache && configCache.port === port && Date.now() - configCache.at < CONFIG_TTL) return configCache.value;
  try {
    const res = await call<BridgeConfig>("/config");
    if (res.status === 200 && res.data) {
      configCache = { value: res.data, at: Date.now(), port };
      return res.data;
    }
  } catch {
    // app not running
  }
  configCache = null;
  return null;
}

export async function sendDownload(req: DownloadRequest): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await call<{ accepted: boolean; reason?: string }>("/downloads", req, 25_000);
    return { ok: res.status === 202, reason: res.data?.reason };
  } catch {
    return { ok: false, reason: "TurboDL is not running." };
  }
}

export async function sendMedia(req: MediaRequest): Promise<boolean> {
  try {
    return (await call("/media", req, 10_000)).status === 202;
  } catch {
    return false;
  }
}

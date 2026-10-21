import { BrowserWindow, session, type Session } from "electron";
import type { BrowserCookie } from "@turbodl/shared";
import { chromeAgent } from "./agent";
import type { PageDriver } from "./finder";

export const INSTAGRAM_PARTITION = "persist:instagram";

const MAX_DOCUMENT = 4 * 1024 * 1024;
const MAX_PAGE = 32 * 1024 * 1024;

/** Pages and requests the hidden windows may load: Instagram itself. */
export function isInstagramAddress(address: string): boolean {
  try {
    const u = new URL(address);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && (host === "instagram.com" || host.endsWith(".instagram.com"));
  } catch {
    return false;
  }
}

/** The session the hidden pages and the sign-in window share; nothing it asks for (camera, notifications…) is granted. */
export function instagramSession(): Session {
  const s = session.fromPartition(INSTAGRAM_PARTITION);
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setUserAgent(chromeAgent(s.getUserAgent()));
  return s;
}

/** Puts kept cookies into the session before a page loads. */
export async function applyCookies(s: Session, cookies: BrowserCookie[]): Promise<void> {
  for (const c of cookies) {
    const host = c.domain.replace(/^\.+/, "");
    try {
      await s.cookies.set({
        url: `https://${host}${c.path || "/"}`,
        name: c.name,
        value: c.value,
        ...(c.hostOnly ? {} : { domain: c.domain }),
        path: c.path || "/",
        secure: c.secure,
        ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
      });
    } catch {
      // one bad cookie doesn't keep the others out
    }
  }
}

/**
 * An Instagram page in a window that is never shown: sandboxed, no preload, only Instagram addresses. Its JSON
 * answers are read from the DevTools protocol in the main process, so nothing is injected into the page.
 */
export class ElectronInstagramPage implements PageDriver {
  private win: BrowserWindow | null = null;
  private readonly answers: string[] = [];
  private readonly waiting = new Set<string>();
  private bytes = 0;

  constructor(private readonly cookies: BrowserCookie[]) {}

  async load(url: string): Promise<void> {
    const s = instagramSession();
    await applyCookies(s, this.cookies);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.win = win;
    const contents = win.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, address) => {
      if (!isInstagramAddress(address)) event.preventDefault();
    });
    const dbg = contents.debugger;
    dbg.attach("1.3");
    dbg.on("message", (_event, method: string, params: Record<string, any>) => {
      if (method === "Network.responseReceived") {
        const response = params.response as { url: string; mimeType?: string };
        if (isInstagramAddress(response.url) && /json|javascript/i.test(response.mimeType ?? "")) this.waiting.add(params.requestId as string);
      } else if (method === "Network.loadingFinished" && this.waiting.delete(params.requestId as string)) {
        void this.keep(params.requestId as string);
      }
    });
    await dbg.sendCommand("Network.enable");
    try {
      await win.loadURL(url);
    } catch {
      // a redirect (to the sign-in page, say) aborts the first load; the page that follows is what counts
    }
  }

  async documents(): Promise<string[]> {
    const contents = this.win?.webContents;
    if (!contents || contents.isDestroyed()) return [...this.answers];
    let embedded: string[] = [];
    try {
      const found: unknown = await contents.executeJavaScript(
        'Array.from(document.querySelectorAll(\'script[type="application/json"]\')).map((s) => s.textContent || "")',
      );
      if (Array.isArray(found)) embedded = found.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= MAX_DOCUMENT);
    } catch {
      // the page is between loads
    }
    return [...this.answers, ...embedded];
  }

  finalUrl(): string {
    const contents = this.win?.webContents;
    return contents && !contents.isDestroyed() ? contents.getURL() : "about:blank";
  }

  close(): void {
    const win = this.win;
    this.win = null;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.debugger.detach();
    } catch {
      // already detached
    }
    win.destroy();
  }

  private async keep(requestId: string): Promise<void> {
    const dbg = this.win?.webContents.debugger;
    if (!dbg) return;
    try {
      const { body, base64Encoded } = (await dbg.sendCommand("Network.getResponseBody", { requestId })) as { body: string; base64Encoded: boolean };
      const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      if (text.length > MAX_DOCUMENT || this.bytes + text.length > MAX_PAGE) return;
      this.bytes += text.length;
      this.answers.push(text);
    } catch {
      // the answer is gone (the page moved on)
    }
  }
}

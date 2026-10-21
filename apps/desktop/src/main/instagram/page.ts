import { BrowserWindow, session, type Session } from "electron";
import { SavedError, type BrowserCookie } from "@turbodl/shared";
import { chromeAgent } from "./agent";
import { within } from "./finder";
import type { ProfileDriver } from "./profile-feed";
import { INSTAGRAM_PARTITION, blockedFrame, electronCookie, isInstagramAddress } from "./partition";
import { postsRequest, resendScript, type PostsRequest } from "./posts-request";

const MAX_DOCUMENT = 4 * 1024 * 1024;
const MAX_PAGE = 32 * 1024 * 1024;
/** ms a re-sent posts request may take */
const RESEND_TIMEOUT = 30_000;

/** The hidden pages' contents; the sign-in window may show frames from elsewhere (Instagram's captcha). */
const hiddenPages = new Set<number>();
let configured: Session | null = null;
/** End-to-end tests only: the origin of a stand-in for Instagram the hidden pages may load too. */
let testSite: string | null = null;

export function allowTestSite(address: string): void {
  testSite = new URL(address).origin;
}

/** Instagram's addresses (and the test stand-in's). */
function allowed(address: string): boolean {
  if (isInstagramAddress(address)) return true;
  try {
    return testSite !== null && new URL(address).origin === testSite;
  } catch {
    return false;
  }
}

/**
 * The session the hidden pages and the sign-in window share: nothing it asks for (camera, notifications…) is
 * granted, and no page leaves Instagram, not even through a redirect.
 */
export function instagramSession(): Session {
  if (configured) return configured;
  const s = session.fromPartition(INSTAGRAM_PARTITION);
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setUserAgent(chromeAgent(s.getUserAgent()));
  s.webRequest.onBeforeRequest((details, callback) => {
    const frame = details.resourceType === "mainFrame" || hiddenPages.has(details.webContentsId ?? -1);
    callback({ cancel: frame && blockedFrame(details.resourceType, details.url) && !allowed(details.url) });
  });
  configured = s;
  return s;
}

/** Puts kept cookies into the session before a page loads. */
export async function applyCookies(s: Session, cookies: BrowserCookie[]): Promise<void> {
  for (const c of cookies) {
    try {
      await s.cookies.set(electronCookie(c));
    } catch {
      // one bad cookie doesn't keep the others out
    }
  }
}

/**
 * An Instagram page in a window that is never shown: sandboxed, no preload, only Instagram addresses. Its JSON
 * answers are read from the DevTools protocol in the main process, so nothing is injected into the page.
 */
export class ElectronInstagramPage implements ProfileDriver {
  private win: BrowserWindow | null = null;
  private readonly answers: string[] = [];
  private readonly waiting = new Set<string>();
  /** graphql POSTs in flight, one of which may be the page's own posts request */
  private readonly sent = new Map<string, { url: string; method: string; headers: Record<string, string>; body?: string; hasPostData?: boolean }>();
  private request: PostsRequest | null = null;
  private collecting = true;
  private bytes = 0;
  private closed = false;

  constructor(private readonly cookies: BrowserCookie[]) {}

  async load(url: string): Promise<void> {
    const s = instagramSession();
    await applyCookies(s, this.cookies);
    // closed while the cookies went in: no window is made at all
    if (this.closed) return;
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.win = win;
    const contents = win.webContents;
    const id = contents.id;
    hiddenPages.add(id);
    win.on("closed", () => hiddenPages.delete(id));
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, address) => {
      if (!allowed(address)) event.preventDefault();
    });
    const dbg = contents.debugger;
    dbg.attach("1.3");
    dbg.on("message", (_event, method: string, params: Record<string, any>) => {
      const id = params.requestId as string;
      if (method === "Network.requestWillBeSent") {
        const r = params.request as { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
        if (r.method === "POST" && allowed(r.url) && r.url.includes("graphql")) this.sent.set(id, { url: r.url, method: r.method, headers: r.headers, body: r.postData, hasPostData: r.hasPostData });
      } else if (method === "Network.responseReceived") {
        const response = params.response as { url: string; mimeType?: string };
        if (allowed(response.url) && /json|javascript/i.test(response.mimeType ?? "")) this.waiting.add(id);
      } else if (method === "Network.loadingFinished") {
        if (this.waiting.delete(id)) void this.keep(id);
        else this.sent.delete(id);
      } else if (method === "Network.loadingFailed") {
        this.waiting.delete(id);
        this.sent.delete(id);
      }
    });
    // A window that hasn't loaded anything has no page for the DevTools protocol yet, and Network.enable waits forever.
    await win.loadURL("about:blank");
    if (this.closed) return;
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

  async scrollToEnd(): Promise<void> {
    const contents = this.win?.webContents;
    if (!contents || contents.isDestroyed()) return;
    await within(contents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight); true").catch(() => undefined), Date.now() + 2000);
  }

  /**
   * The page's own posts request sent again from after `cursor`, from inside the page; null until the page has sent
   * one. Throws badAnswer when it fails or takes longer than 30 s.
   */
  async resend(cursor: string): Promise<{ status: number; text: string } | null> {
    const request = this.request;
    const contents = this.win?.webContents;
    if (!request || !contents || contents.isDestroyed()) return null;
    const answer = (await within(contents.executeJavaScript(resendScript(request, cursor)).catch(() => undefined), Date.now() + RESEND_TIMEOUT)) as
      | { status?: unknown; text?: unknown }
      | undefined;
    if (typeof answer?.status !== "number" || typeof answer.text !== "string") throw new SavedError("badAnswer");
    return { status: answer.status, text: answer.text };
  }

  /** The first load is read: its answers are forgotten and no more are kept (each posts answer is over a megabyte). */
  stopCollecting(): void {
    this.collecting = false;
    this.answers.length = 0;
    this.bytes = 0;
  }

  close(): void {
    this.closed = true;
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
    const sent = this.sent.get(requestId);
    this.sent.delete(requestId);
    // after the first load only a graphql POST is still worth reading, while the posts request isn't known yet
    if (!dbg || (!this.collecting && (!sent || this.request))) return;
    try {
      const { body, base64Encoded } = (await dbg.sendCommand("Network.getResponseBody", { requestId })) as { body: string; base64Encoded: boolean };
      const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      if (sent && !this.request) {
        const form = sent.body ?? (sent.hasPostData ? ((await dbg.sendCommand("Network.getRequestPostData", { requestId })) as { postData: string }).postData : undefined);
        this.request = postsRequest({ ...sent, body: form }, text) ?? this.request;
      }
      if (!this.collecting || text.length > MAX_DOCUMENT || this.bytes + text.length > MAX_PAGE) return;
      this.bytes += text.length;
      this.answers.push(text);
    } catch {
      // the answer is gone (the page moved on)
    }
  }
}

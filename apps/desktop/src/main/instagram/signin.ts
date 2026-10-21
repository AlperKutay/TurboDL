import { BrowserWindow, type Cookie } from "electron";
import type { BrowserCookie } from "@turbodl/shared";
import { instagramSession } from "./page";
import { fromElectronCookie, isInstagramAddress, signedInNow } from "./partition";

const SIGN_IN = "https://www.instagram.com/accounts/login/";

const instagramCookies = (cookies: Cookie[]) => cookies.filter((c) => (c.domain ?? "").replace(/^\.+/, "").endsWith("instagram.com"));
const sessionValue = (cookies: Cookie[]) => cookies.find((c) => c.name === "sessionid" && c.value)?.value;

/**
 * Instagram's own sign-in page in a TurboDL window, on the session the hidden pages use, or the check page `at` a
 * hidden page landed on. Resolves with Instagram's cookies once signed in (see `signedInNow`), or null when the window
 * is closed first.
 */
export async function signInToInstagram(at?: string): Promise<BrowserCookie[] | null> {
  const s = instagramSession();
  const initial = sessionValue(instagramCookies(await s.cookies.get({})));
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: "Sign in to Instagram",
      autoHideMenuBar: true,
      webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const check = async () => {
      if (done || win.isDestroyed()) return;
      const cookies = instagramCookies(await s.cookies.get({}));
      if (done || win.isDestroyed() || !signedInNow(initial, sessionValue(cookies), win.webContents.getURL())) return;
      done = true;
      resolve(cookies.map(fromElectronCookie));
      win.destroy();
    };
    const onChanged = (_event: unknown, cookie: Cookie, _cause: string, removed: boolean) => {
      if (!removed && cookie.name === "sessionid") void check();
    };
    s.cookies.on("changed", onChanged);
    win.on("closed", () => {
      s.cookies.off("changed", onChanged);
      if (!done) resolve(null);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, address) => {
      if (!isInstagramAddress(address)) event.preventDefault();
    });
    win.webContents.on("did-finish-load", () => void check());
    win.webContents.on("did-navigate-in-page", () => void check());
    void win.loadURL(at && isInstagramAddress(at) ? at : SIGN_IN).catch(() => undefined);
  });
}

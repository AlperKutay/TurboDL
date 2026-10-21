import { BrowserWindow, type Cookie } from "electron";
import type { BrowserCookie } from "@turbodl/shared";
import { instagramSession, isInstagramAddress } from "./page";

function toBrowserCookie(c: Cookie): BrowserCookie {
  return {
    domain: c.domain ?? "",
    hostOnly: c.hostOnly ?? false,
    path: c.path ?? "/",
    secure: c.secure ?? true,
    expires: c.expirationDate ?? 0,
    name: c.name,
    value: c.value,
  };
}

/**
 * Instagram's own sign-in page in a TurboDL window, on the session the hidden pages use. Resolves with Instagram's
 * cookies once `sessionid` is there (also when it already was), or null when the window is closed first.
 */
export function signInToInstagram(): Promise<BrowserCookie[] | null> {
  return new Promise((resolve) => {
    const s = instagramSession();
    const win = new BrowserWindow({
      width: 480,
      height: 760,
      title: "Sign in to Instagram",
      autoHideMenuBar: true,
      webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const check = async () => {
      if (done) return;
      const cookies = (await s.cookies.get({})).filter((c) => (c.domain ?? "").replace(/^\.+/, "").endsWith("instagram.com"));
      if (!cookies.some((c) => c.name === "sessionid" && c.value)) return;
      done = true;
      resolve(cookies.map(toBrowserCookie));
      if (!win.isDestroyed()) win.destroy();
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
    void win.loadURL("https://www.instagram.com/accounts/login/").catch(() => undefined);
  });
}

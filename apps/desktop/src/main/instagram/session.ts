import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserCookie } from "@turbodl/shared";

/** Electron's `safeStorage` in the app; a stand-in in tests. */
export interface Crypt {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

/** Electron's safeStorage as a Crypt; on Linux, Chromium's "basic_text" fallback (a fixed, public key) counts as unavailable. */
export function systemCrypt(platform: NodeJS.Platform, s: SafeStorageLike): Crypt {
  return {
    available: () => {
      if (!s.isEncryptionAvailable()) return false;
      if (platform !== "linux") return true;
      try {
        const backend = s.getSelectedStorageBackend?.();
        return backend !== undefined && backend !== "basic_text";
      } catch {
        return false;
      }
    },
    encrypt: (text) => s.encryptString(text),
    decrypt: (data) => s.decryptString(data),
  };
}

function isInstagram(domain: string): boolean {
  const host = domain.replace(/^\.+/, "").toLowerCase();
  return host === "instagram.com" || host.endsWith(".instagram.com");
}

/**
 * The Instagram session TurboDL reads pages with: the browser's cookies (from the extension's cookie jars) or
 * those of a sign-in in TurboDL. On disk only encrypted by the system; in memory only when it can't encrypt.
 */
export class InstagramSession {
  private jar: BrowserCookie[] = [];

  constructor(
    private readonly file: string,
    private readonly crypt: Crypt,
  ) {}

  /** Reads what was kept; a missing or unreadable file is no session. */
  load(): void {
    this.jar = [];
    if (!existsSync(this.file) || !this.crypt.available()) return;
    try {
      const parsed: unknown = JSON.parse(this.crypt.decrypt(readFileSync(this.file)));
      if (Array.isArray(parsed)) this.jar = parsed.filter((c): c is BrowserCookie => typeof c?.name === "string" && typeof c?.domain === "string");
    } catch {
      this.jar = [];
    }
  }

  cookies(): BrowserCookie[] {
    return this.jar.map((c) => ({ ...c }));
  }

  /** A `sessionid` that hasn't expired. */
  signedIn(now = new Date()): boolean {
    return this.jar.some((c) => c.name === "sessionid" && c.value !== "" && (c.expires === 0 || c.expires * 1000 > now.getTime()));
  }

  /** Takes a jar's Instagram cookies when they hold a session; a jar without one leaves the kept session alone. */
  take(jar: BrowserCookie[]): boolean {
    const mine = jar.filter((c) => isInstagram(c.domain));
    if (!mine.some((c) => c.name === "sessionid" && c.value !== "")) return false;
    this.jar = mine.map((c) => ({ ...c }));
    this.save();
    return true;
  }

  clear(): void {
    this.jar = [];
    rmSync(this.file, { force: true });
  }

  private save(): void {
    if (!this.crypt.available()) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.crypt.encrypt(JSON.stringify(this.jar)));
  }
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The system's encryption (Electron's safeStorage in the app); decrypting may wait on a keyring, so it is async. */
export interface TokenCrypt {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): Promise<string>;
}

/** how long reading the token may take before it counts as unreadable (a keyring that never answers) */
export const READ_TIMEOUT_MS = 5000;

const ENCRYPTED_FILE = "telegram-token.bin";
const PLAIN_FILE = "telegram-token";

export type LoadedToken = { token: string } | { unreadable: true };

/**
 * The bot token, apart from the settings: encrypted by the system when it can (`telegram-token.bin`), otherwise in
 * plain text readable only by the user (`telegram-token`, mode 0600). Only one of the two files exists at a time.
 */
export class TokenStore {
  private readonly encryptedFile: string;
  private readonly plainFile: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly dir: string,
    private readonly crypt: TokenCrypt,
    o: { timeoutMs?: number } = {},
  ) {
    this.encryptedFile = path.join(dir, ENCRYPTED_FILE);
    this.plainFile = path.join(dir, PLAIN_FILE);
    this.timeoutMs = o.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /** The saved token; unreadable when its file is broken or the system can't decrypt it in time; null when there is none. */
  async load(): Promise<LoadedToken | null> {
    try {
      if (existsSync(this.encryptedFile)) return readable(await this.decrypt(readFileSync(this.encryptedFile)));
      if (existsSync(this.plainFile)) return readable(readFileSync(this.plainFile, "utf8"));
      return null;
    } catch {
      return { unreadable: true };
    }
  }

  /** Writes the token (null: removes it); the file of the other kind goes. Throws when the file can't be written. */
  save(token: string | null): void {
    if (token === null) {
      rmSync(this.encryptedFile, { force: true });
      rmSync(this.plainFile, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    if (this.crypt.available()) {
      writeAtomic(this.encryptedFile, this.crypt.encrypt(token));
      rmSync(this.plainFile, { force: true });
    } else {
      writeAtomic(this.plainFile, token);
      rmSync(this.encryptedFile, { force: true });
    }
  }

  /** The system's decrypt, given up after the timeout. */
  private decrypt(data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The system took too long to decrypt the token")), this.timeoutMs);
      timer.unref?.();
      let pending: Promise<string>;
      try {
        pending = this.crypt.decrypt(data);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      pending.then(
        (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

function readable(text: string): LoadedToken {
  const token = text.trim();
  return token ? { token } : { unreadable: true };
}

/** tmp + rename, readable only by the user (the mode is set on the tmp file, which the rename keeps) */
function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  // a tmp file left from before keeps its old mode: writeFileSync sets the mode only on creation
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

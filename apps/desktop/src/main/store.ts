import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A JSON file written atomically (tmp + rename) with debounced saves. */
export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 300,
  ) {}

  load(fallback: () => T): T {
    if (!existsSync(this.file)) return fallback();
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as T;
    } catch {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        // ignore: the backup is best effort
      }
      return fallback();
    }
  }

  save(data: T): void {
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const data = this.pending;
    this.pending = null;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}

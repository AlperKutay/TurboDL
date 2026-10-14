export interface ClipboardWatcherOptions {
  /** Electron's clipboard.readText() is asynchronous since Electron 44 */
  read(): string | Promise<string>;
  onText(text: string): void;
  intervalMs?: number;
}

/** Polls the clipboard and reports text copied after start(); whatever was there before is ignored. */
export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last = "";
  private ready: Promise<void> = Promise.resolve();
  private busy = false;

  constructor(private readonly o: ClipboardWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    this.ready = this.read().then((text) => {
      this.last = text;
    });
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.ready;
      const text = await this.read();
      if (!this.timer || text === this.last) return;
      this.last = text;
      if (text) this.o.onText(text);
    } finally {
      this.busy = false;
    }
  }

  private async read(): Promise<string> {
    try {
      return await this.o.read();
    } catch {
      return this.last;
    }
  }
}

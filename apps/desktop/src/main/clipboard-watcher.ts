export interface ClipboardWatcherOptions {
  read(): string;
  onText(text: string): void;
  intervalMs?: number;
}

/** Polls the clipboard and reports text copied after start(); whatever was there before is ignored. */
export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last = "";

  constructor(private readonly o: ClipboardWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    this.last = this.read();
    this.timer = setInterval(() => this.check(), this.o.intervalMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private check(): void {
    const text = this.read();
    if (text === this.last) return;
    this.last = text;
    if (text) this.o.onText(text);
  }

  private read(): string {
    try {
      return this.o.read();
    } catch {
      return this.last;
    }
  }
}

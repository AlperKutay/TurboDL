/** What a wait for a place answers when its signal aborts first. */
const CALLED_OFF = "Cancelled.";

/** At most `size` holders at once; the others wait for a place in arrival order. */
export class Gate {
  private used = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly size: number) {}

  /** Waits for a place: resolves with its release (once is enough; later calls do nothing), or rejects, taking none, when `signal` aborts first. */
  take(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(CALLED_OFF));
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.used++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.used--;
          this.waiting.shift()?.();
        });
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new Error(CALLED_OFF));
      };
      if (this.used < this.size) return grant();
      this.waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

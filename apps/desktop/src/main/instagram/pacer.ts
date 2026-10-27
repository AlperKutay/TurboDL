import { SavedError, type SavedPageResult } from "@turbodl/shared";

/** ms between requests Instagram sees from the account: saved feeds and profile pages, the grids' and backups' alike */
const GAP = 1500;
/** ms nothing is asked after Instagram asked to slow down */
const HOLD = 2 * 60_000;

export const SLOW_DOWN = "Instagram asked TurboDL to slow down. Try again in a few minutes.";

/**
 * One pace for the whole account: every request gets its own slot 1.5 s after the one before, and Instagram asking to
 * slow down holds every request for 2 minutes, whichever screen or backup asks.
 */
export class InstagramPacer {
  private nextAt = 0;
  private heldUntil = 0;

  constructor(
    private readonly now: () => number,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) {}

  /** Takes the next slot and waits for it (or until `signal` aborts). */
  async pace(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + GAP;
    if (at > now) await this.wait(at - now, signal).catch(() => undefined);
  }

  /** A request to Instagram; its "slow down" holds every other one. */
  async ask<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof SavedError && err.kind === "rateLimited") this.hold();
      throw err;
    }
  }

  /** Holds every request for 2 minutes from now, as Instagram asking to slow down does (its login wall, say). */
  hold(): void {
    this.heldUntil = this.now() + HOLD;
  }

  held(): boolean {
    return this.now() < this.heldUntil;
  }
}

/** A failed page for a grid: signed out, slow down, or the reason in words. */
export function failedPage(err: unknown): Exclude<SavedPageResult, { type: "page" }> {
  if (err instanceof SavedError && (err.kind === "signedOut" || err.kind === "rateLimited")) return { type: err.kind };
  return { type: "failed", message: failureText(err) };
}

export function failureText(err: unknown): string {
  if (err instanceof SavedError) return err.kind === "http" ? err.message : "Instagram's answer couldn't be read.";
  return err instanceof Error ? err.message : String(err);
}

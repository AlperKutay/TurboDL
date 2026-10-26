import type { Job } from "@turbodl/shared";

/** The turbodl command's exit codes. */
export const EXIT = { ok: 0, failed: 1, usage: 2, signIn: 3, rateLimited: 4, unreachable: 5, stopped: 6, interrupted: 130 } as const;

/** A followed job's code; `cancelledHere`: this command cancelled it. A job not ended (the stream closed first) is 5. */
export function exitCodeOf(job: Job, cancelledHere: boolean): number {
  switch (job.state) {
    case "done":
      return job.limited ? EXIT.signIn : EXIT.ok;
    case "failed":
      if (job.reason === "signInRequired") return EXIT.signIn;
      if (job.reason === "rateLimited") return EXIT.rateLimited;
      return EXIT.failed;
    case "cancelled":
      return cancelledHere ? EXIT.interrupted : EXIT.stopped;
    default:
      return EXIT.unreachable;
  }
}

/** The first that applies of 5, 130, 6, 1, 4, 3, 0. */
export function combineExit(codes: number[]): number {
  const order = [EXIT.unreachable, EXIT.interrupted, EXIT.stopped, EXIT.failed, EXIT.rateLimited, EXIT.signIn];
  return order.find((code) => codes.includes(code)) ?? EXIT.ok;
}

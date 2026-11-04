import { describe, expect, it } from "vitest";
import type { Job, JobReason, JobState, ListState, ProfileListRow } from "@turbodl/shared";
import { combineExit, EXIT, exitCodeOf, listExitCode } from "../../src/cli/exit";

function list(state: ListState, rows: ProfileListRow["state"][] = ["done"]) {
  return {
    name: "list.txt",
    rows: rows.map((s, i) => ({ username: `u${i}`, state: s })),
    index: 0,
    state,
    options: { posts: true, highlights: false, tagged: false, photos: true, videos: true },
    wait: { min: 2, max: 5 }
  };
}

describe("listExitCode", () => {
  it("is 0 for a finished list, 1 when one of its profiles failed", () => {
    expect(listExitCode(list("finished", ["done", "skipped"]), false)).toBe(EXIT.ok);
    expect(listExitCode(list("finished", ["done", "failed", "skipped"]), false)).toBe(EXIT.failed);
  });

  it("maps a list that stopped by itself or elsewhere", () => {
    expect(listExitCode(list("rateLimited"), false)).toBe(EXIT.rateLimited);
    expect(listExitCode(list("signedOut"), false)).toBe(EXIT.signIn);
    expect(listExitCode(list("stopped"), false)).toBe(EXIT.stopped);
  });

  it("is 130 for a list this command stopped", () => {
    expect(listExitCode(list("stopped"), true)).toBe(EXIT.interrupted);
    // it ended on its own before the stop reached it
    expect(listExitCode(list("finished"), true)).toBe(EXIT.ok);
  });
});

function job(state: JobState, extra: { reason?: JobReason; limited?: boolean } = {}): Job {
  return {
    id: "j1",
    url: "https://example.com/a",
    kind: "file",
    state,
    warnings: [],
    files: [],
    failedItems: 0,
    progress: { done: 0 },
    createdAt: 0,
    ...extra
  };
}

describe("exitCodeOf", () => {
  it("maps done jobs", () => {
    expect(exitCodeOf(job("done"), false)).toBe(0);
    expect(exitCodeOf(job("done", { limited: true }), false)).toBe(3);
  });

  it("maps failed jobs by reason", () => {
    expect(exitCodeOf(job("failed", { reason: "signInRequired" }), false)).toBe(3);
    expect(exitCodeOf(job("failed", { reason: "rateLimited" }), false)).toBe(4);
    expect(exitCodeOf(job("failed", { reason: "notFound" }), false)).toBe(1);
    expect(exitCodeOf(job("failed"), false)).toBe(1);
  });

  it("maps cancelled jobs by who cancelled them", () => {
    expect(exitCodeOf(job("cancelled"), true)).toBe(130);
    expect(exitCodeOf(job("cancelled"), false)).toBe(6);
  });

  it("treats a job that has not ended as unreachable", () => {
    expect(exitCodeOf(job("queued"), false)).toBe(5);
    expect(exitCodeOf(job("running"), false)).toBe(5);
  });
});

describe("combineExit", () => {
  it("picks the first code that applies of 5, 130, 6, 1, 4, 3, 0", () => {
    expect(combineExit([0, 3, 1])).toBe(1);
    expect(combineExit([4, 3])).toBe(4);
    expect(combineExit([0, 6, 1])).toBe(6);
    expect(combineExit([130, 5])).toBe(5);
    expect(combineExit([3, 0])).toBe(3);
    expect(combineExit([0, 0])).toBe(0);
    expect(combineExit([])).toBe(0);
  });

  it("exposes the code table", () => {
    expect(EXIT.usage).toBe(2);
    expect(EXIT.interrupted).toBe(130);
  });
});

import { describe, expect, it } from "vitest";
import type { Job, JobReason, ProfileListRow, ProfileListView } from "@turbodl/shared";
import {
  MAX_TEXT,
  jobFinalText,
  jobKeyboard,
  jobLabel,
  jobSummary,
  jobText,
  listKeyboard,
  listRestartedText,
  listText,
  reasonText,
  statusText,
  stopKeyboard,
} from "../../src/main/telegram/texts";
import type { Keyboard } from "../../src/main/telegram/types";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    url: "https://www.instagram.com/nasa/",
    kind: "instagramProfile",
    state: "running",
    warnings: [],
    files: [],
    failedItems: 0,
    progress: { done: 3, total: 10 },
    createdAt: 0,
    ...over,
  };
}

function list(over: Partial<ProfileListView> = {}): ProfileListView {
  return {
    name: "mylist.txt",
    rows: [],
    index: 0,
    state: "running",
    options: { posts: true, highlights: true, tagged: false, photos: true, videos: true },
    wait: { min: 2, max: 5 },
    ...over,
  };
}

const longNote = "x".repeat(300);

function rows(n: number): ProfileListRow[] {
  return Array.from({ length: n }, (_, i) => ({ username: `user_${i}`, state: i % 2 ? "failed" : "done", note: longNote }));
}

function datas(k: Keyboard | null): string[] {
  return (k ?? []).flat().map((b) => b.callback_data);
}

describe("texts", () => {
  it("every text stays under 4096", () => {
    const big = list({ rows: rows(1000), index: 500, nextAt: 60_000, state: "waiting", message: longNote, progress: { done: 1, total: 2, note: longNote } });
    expect(listText(big, 0).length).toBeLessThanOrEqual(MAX_TEXT);
    expect(listRestartedText(big).length).toBeLessThanOrEqual(MAX_TEXT);
    const noisy = job({ warnings: Array.from({ length: 50 }, () => longNote), files: ["/a/b.jpg"], progress: { done: 1, note: longNote }, error: longNote, state: "failed" });
    for (const t of [jobText(noisy, "x"), jobFinalText(noisy, "x", 1), jobSummary(noisy, "x", 1), reasonText(noisy)]) {
      expect(t.length).toBeLessThanOrEqual(MAX_TEXT);
    }
    const jobs = Array.from({ length: 10 }, (_, i) => ({ label: "L".repeat(500) + i, job: job({ id: `j${i}`, progress: { done: 1, note: longNote } }) }));
    const status = statusText({ version: "0.10.0", instagram: { signedIn: true, username: "me" }, jobs, list: big });
    expect(status.length).toBeLessThanOrEqual(MAX_TEXT);
  });

  it("cuts an over-long text with a trailing ellipsis", () => {
    const t = reasonText(job({ error: "y".repeat(5000) }));
    expect(t).toHaveLength(MAX_TEXT);
    expect(t.endsWith("…")).toBe(true);
  });

  it("jobLabel names profiles and links", () => {
    expect(jobLabel({ url: "https://www.instagram.com/nasa/", kind: "instagramProfile" })).toBe("@nasa profile backup");
    expect(jobLabel({ url: "https://example.com/files/movie.mp4?x=1", kind: "file" })).toBe("example.com movie.mp4");
  });

  it("jobText shows state, counts, bytes and the note", () => {
    const t = jobText(job({ state: "queued", progress: { done: 2, total: 5, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, speed: 2048, note: "reading posts" } }), "@nasa profile backup");
    expect(t).toContain("@nasa profile backup");
    expect(t).toContain("Queued");
    expect(t).toContain("2/5");
    expect(t).toContain("1.0 MB");
    expect(t).toContain("2.0 KB/s");
    expect(t).toContain("reading posts");
  });

  it("jobSummary counts what was already there", () => {
    const files = Array.from({ length: 143 }, (_, i) => `/dl/nasa/${i}.jpg`);
    const t = jobSummary(job({ state: "done", files }), "@nasa profile backup", 12);
    expect(t).toMatch(/^Done: /);
    expect(t).toContain("143");
    expect(t).toContain("12");
  });

  it("jobSummary says failed items and failures", () => {
    expect(jobSummary(job({ state: "done", files: ["/a/b"], failedItems: 2 }), "x", 0)).toMatch(/^Done with 2 failed items: /);
    expect(jobSummary(job({ state: "failed", reason: "private" }), "x", 0)).toMatch(/^Failed: /);
  });

  it("jobSummary names the folder of the first file", () => {
    expect(jobSummary(job({ state: "done", files: ["/dl/nasa/a.jpg", "/other/b.jpg"] }), "x", 0)).toContain("/dl/nasa");
    expect(jobSummary(job({ state: "done", files: ["C:\\dl\\nasa\\a.jpg"] }), "x", 0)).toContain("C:\\dl\\nasa");
  });

  it("reasonText words each reason", () => {
    const reasons: JobReason[] = ["signInRequired", "rateLimited", "private", "notFound", "unsupported", "stopped", "error"];
    const texts = reasons.map((reason) => reasonText(job({ reason })));
    expect(new Set(texts).size).toBe(7);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
    expect(reasonText(job({ reason: "error", error: "boom" }))).toBe("boom");
    expect(reasonText(job({ error: "boom" }))).toBe("boom");
    expect(reasonText(job())).toBe("Something went wrong.");
  });

  it("listKeyboard by state", () => {
    expect(listKeyboard(list({ state: "running" }))).toEqual([[{ text: "Stop", callback_data: "sl" }]]);
    for (const state of ["waiting", "slowedDown"] as const) expect(datas(listKeyboard(list({ state })))).toEqual(["sl"]);
    for (const state of ["stopped", "rateLimited", "signedOut"] as const) expect(datas(listKeyboard(list({ state })))).toEqual(["lc", "lx"]);
    expect(listKeyboard(list({ state: "finished" }))).toEqual([[{ text: "Close", callback_data: "lx" }]]);
  });

  it("listText shows the running profile, the next start and the last 5 rows", () => {
    const rs: ProfileListRow[] = [
      ...Array.from({ length: 8 }, (_, i): ProfileListRow => ({ username: `done${i}`, state: "done" })),
      { username: "now", state: "running" },
      { username: "later", state: "waiting" },
    ];
    const t = listText(list({ rows: rs, index: 8, state: "waiting", nextAt: 3 * 60_000, progress: { done: 4, total: 9 } }), 0);
    expect(t).toContain("mylist.txt");
    expect(t).toContain("@now");
    expect(t).toContain("3 min");
    for (const n of [3, 4, 5, 6, 7]) expect(t).toContain(`@done${n}`);
    for (const n of [0, 1, 2]) expect(t).not.toContain(`@done${n}`);
    expect(t).toContain("8/10");
  });

  it("listRestartedText says where the list stopped", () => {
    const rs = Array.from({ length: 1000 }, (_, i): ProfileListRow => ({ username: `u${i}`, state: i < 120 ? "done" : "waiting" }));
    expect(listRestartedText(list({ rows: rs, state: "stopped" }))).toBe("TurboDL restarted; the list stopped at 120/1000.");
  });

  it("stopKeyboard is null when nothing runs", () => {
    expect(stopKeyboard([], false)).toBeNull();
    expect(stopKeyboard([{ label: "a", job: job({ state: "done" }) }], false)).toBeNull();
    expect(datas(stopKeyboard([{ label: "a", job: job() }], true))).toEqual(["s:job-1", "sl", "sa"]);
  });

  it("every callback_data fits in 64 bytes", () => {
    const id = "0123456789abcdef0123456789abcdef0123";
    const ks = [jobKeyboard(id), stopKeyboard([{ label: "é".repeat(100), job: job({ id }) }], true), listKeyboard(list({ state: "stopped" }))];
    for (const k of ks) for (const d of datas(k)) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(jobKeyboard("abc")).toEqual([[{ text: "Stop", callback_data: "s:abc" }]]);
  });
});

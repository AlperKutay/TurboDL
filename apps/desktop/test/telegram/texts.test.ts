import { describe, expect, it } from "vitest";
import type { Job, JobReason, ProfileListRow, ProfileListView } from "@turbodl/shared";
import {
  MAX_TEXT,
  clip,
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
    // very long names in the rows that are shown push the list text past the cap
    const wide = Array.from({ length: 1000 }, (_, i): ProfileListRow => ({ username: "u".repeat(2000) + i, state: "done", note: longNote }));
    const big = list({ rows: [...wide, { username: "n".repeat(3000), state: "running" }], index: 1000, nextAt: 60_000, state: "waiting", message: longNote, progress: { done: 1, total: 2, note: longNote } });
    const over = [
      listText(big, 0),
      jobFinalText(job({ state: "failed", error: "y".repeat(9000) }), "x", 0),
      jobSummary(job({ state: "failed", error: "y".repeat(9000) }), "x", 0),
      reasonText(job({ error: "y".repeat(9000) })),
    ];
    for (const t of over) {
      expect(t).toHaveLength(MAX_TEXT);
      expect(t.endsWith("…")).toBe(true);
    }
    expect(listRestartedText(big).length).toBeLessThanOrEqual(MAX_TEXT);
    const noisy = job({ warnings: Array.from({ length: 50 }, () => longNote), files: ["/a/b.jpg"], progress: { done: 1, note: longNote } });
    expect(jobText(noisy, "L".repeat(9000)).length).toBeLessThanOrEqual(MAX_TEXT);
    // a done job with a long warning, a long label and a very deep folder
    const deep = job({ state: "done", limited: true, warnings: ["w".repeat(9000)], files: [`/${"d".repeat(9000)}/a.jpg`] });
    const summary = jobSummary(deep, "L".repeat(9000), 3);
    expect(summary).toHaveLength(MAX_TEXT);
    expect(summary).toContain("\nSome parts were left out: ");
    const jobs = Array.from({ length: 12 }, (_, i) => ({ label: "L".repeat(500) + i, job: job({ id: `j${i}`, progress: { done: 1, note: longNote } }) }));
    const status = statusText({ version: "0.10.0", instagram: { signedIn: true, username: "me" }, jobs, list: big });
    expect(status.length).toBeLessThanOrEqual(MAX_TEXT);
  });

  it("never leaves half a surrogate pair before the ellipsis", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    for (const n of [MAX_TEXT, 100, 61]) {
      for (const pad of ["", "a"]) {
        const t = clip(pad + "😀".repeat(MAX_TEXT), n);
        expect(t.length).toBeLessThanOrEqual(n);
        expect(t.endsWith("…")).toBe(true);
        expect(lone.test(t)).toBe(false);
      }
    }
    expect(lone.test(reasonText(job({ error: "a" + "😀".repeat(5000) })))).toBe(false);
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

  it("jobSummary says when parts were left out", () => {
    const files = ["/dl/nasa/a.jpg"];
    // a profile backup's warnings: its plan (news, not a warning), then what it couldn't save; the last one says it
    const plan = "Backing up 6 posts, about 12 MB, 177 GB free on the drive.";
    const warned = job({ state: "done", files, limited: true, warnings: [plan, "This profile has no highlights.", "Tagged posts need a sign-in to Instagram; they weren't saved."] });
    expect(jobSummary(warned, "@nasa profile backup", 0)).toBe(
      "Done: @nasa profile backup — 1 file saved.\nSome parts were left out: Tagged posts need a sign-in to Instagram; they weren't saved.\nFolder: /dl/nasa",
    );
    // the plan alone leaves nothing out
    expect(jobSummary(job({ state: "done", files, warnings: [plan] }), "x", 0)).toBe("Done: x — 1 file saved.\nFolder: /dl/nasa");
    expect(jobSummary(job({ state: "done", files, warnings: ["Backing up every post; it continues an earlier backup."] }), "x", 0)).not.toContain("left out");
    expect(jobSummary(job({ state: "done", files, limited: true, warnings: [plan] }), "x", 0)).toBe("Done: x — 1 file saved.\nSome parts were left out.\nFolder: /dl/nasa");
    expect(jobSummary(job({ state: "done", files, limited: true }), "x", 0)).toBe("Done: x — 1 file saved.\nSome parts were left out.\nFolder: /dl/nasa");
    expect(jobSummary(job({ state: "done", files, warnings: ["Some posts are shown only to signed-in visitors."] }), "x", 0)).toContain(
      "\nSome parts were left out: Some posts are shown only to signed-in visitors.\n",
    );
    // the warning is clipped to 200
    const long = jobSummary(job({ state: "done", files, warnings: ["w".repeat(500)] }), "x", 0);
    expect(long).toContain(`\nSome parts were left out: ${"w".repeat(199)}…\nFolder: `);
    // nothing left out: nothing said
    expect(jobSummary(job({ state: "done", files }), "x", 0)).toBe("Done: x — 1 file saved.\nFolder: /dl/nasa");
    // a failed or stopped job says only that
    expect(jobSummary(job({ state: "failed", reason: "private", warnings: ["w"], limited: true }), "x", 0)).not.toContain("left out");
    expect(jobSummary(job({ state: "cancelled", warnings: ["w"] }), "x", 0)).not.toContain("left out");
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

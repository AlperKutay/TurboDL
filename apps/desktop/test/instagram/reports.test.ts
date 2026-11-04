import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportWriter } from "../../src/main/instagram/reports";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("reportWriter", () => {
  it("writes what the page held to <folder>/<time><suffix>, making the folder", () => {
    dir = mkdtempSync(path.join(tmpdir(), "turbodl-reports-"));
    const folder = path.join(dir, "instagram-reports");
    reportWriter(folder, "-tagged.json", { now: () => 1790000000000 })("https://www.instagram.com/someone/tagged/", ['{"a":1}', "{}"]);
    expect(readdirSync(folder)).toEqual(["1790000000000-tagged.json"]);
    expect(readFileSync(path.join(folder, "1790000000000-tagged.json"), "utf8")).toBe(
      JSON.stringify({ url: "https://www.instagram.com/someone/tagged/", documents: ['{"a":1}', "{}"] }),
    );
  });

  it("keeps only the newest five of its own reports, and leaves other files alone", () => {
    dir = mkdtempSync(path.join(tmpdir(), "turbodl-reports-"));
    writeFileSync(path.join(dir, "5-instagram.json"), "{}");
    writeFileSync(path.join(dir, "notes.txt"), "kept");
    let time = 1;
    const write = reportWriter(dir, "-tagged.json", { now: () => time++ });
    for (let i = 0; i < 7; i++) write("https://www.instagram.com/someone/tagged/", []);
    // a time with more digits still counts as newer
    time = 10;
    write("https://www.instagram.com/someone/tagged/", []);
    expect(readdirSync(dir).sort()).toEqual(["10-tagged.json", "4-tagged.json", "5-instagram.json", "5-tagged.json", "6-tagged.json", "7-tagged.json", "notes.txt"]);
  });

  it("never throws when the report can't be written", () => {
    dir = mkdtempSync(path.join(tmpdir(), "turbodl-reports-"));
    // a file where the folder should be
    const blocked = path.join(dir, "taken");
    writeFileSync(blocked, "");
    expect(() => reportWriter(blocked, "-tagged.json", { warn: () => undefined })("https://www.instagram.com/someone/tagged/", [])).not.toThrow();
  });
});

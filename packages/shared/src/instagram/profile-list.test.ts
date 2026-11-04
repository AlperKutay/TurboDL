import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_WAIT, PROFILE_LIST_MAX, parseProfileList, waitProblem } from "./profile-list";

const MESSAGE = "Waits are whole minutes from 0 to 1440, the most at least the least.";

describe("parseProfileList", () => {
  it("reads every way a profile can be written", () => {
    const text = "﻿nasa\r\n@NatGeo\r\n\r\n# a comment\r\nhttps://www.instagram.com/iremyigtt/?igsh=x\r\nhttps://instagram.com/natgeo/reels/\r\nNASA\r\n";
    expect(parseProfileList(text)).toEqual({ usernames: ["nasa", "natgeo", "iremyigtt"], invalid: [], tooMany: false });
  });

  it("keeps the 1-based line numbers of lines it cannot read", () => {
    const parsed = parseProfileList("ok\nnot a name!\nhttps://www.instagram.com/p/C1/\n");
    expect(parsed.usernames).toEqual(["ok"]);
    expect(parsed.invalid).toEqual([
      { line: 2, text: "not a name!" },
      { line: 3, text: "https://www.instagram.com/p/C1/" },
    ]);
  });

  it("splits on a lone CR and skips indented comments", () => {
    expect(parseProfileList("a\rb\n   # c\n  d  ").usernames).toEqual(["a", "b", "d"]);
  });

  it("flags more than the maximum of distinct names", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `user${i}`).join("\n");
    expect(PROFILE_LIST_MAX).toBe(1000);
    expect(parseProfileList(names(1000)).tooMany).toBe(false);
    expect(parseProfileList(names(1001)).tooMany).toBe(true);
    expect(parseProfileList(`${names(1000)}\nUSER0`).tooMany).toBe(false);
  });
});

describe("waitProblem", () => {
  it("accepts whole minutes from 0 to 1440 with the most at least the least", () => {
    expect(DEFAULT_LIST_WAIT).toEqual({ min: 2, max: 5 });
    expect(waitProblem({ min: 0, max: 0 })).toBeNull();
    expect(waitProblem({ min: 2, max: 5 })).toBeNull();
    expect(waitProblem({ min: 1440, max: 1440 })).toBeNull();
  });

  it("refuses everything else", () => {
    for (const w of [{ min: 5, max: 2 }, { min: -1, max: 3 }, { min: 1.5, max: 3 }, { min: 0, max: 1441 }, { min: "2", max: 5 }, { min: 2, max: null }, { min: NaN, max: 3 }]) {
      expect(waitProblem(w)).toBe(MESSAGE);
    }
  });
});

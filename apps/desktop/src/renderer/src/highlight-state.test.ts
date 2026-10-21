import { describe, expect, it } from "vitest";
import type { HighlightResult } from "@turbodl/shared";
import { nextLoad, readHighlights, togglePick } from "./highlight-state";
import { initialSaved, select, toggle } from "./saved-state";

describe("highlight-state", () => {
  it("keeps highlight picks in the order they were made", () => {
    let picked: string[] = [];
    for (const id of ["b", "a", "b", "c"]) picked = togglePick(picked, id);
    expect(picked).toEqual(["a", "c"]);
  });

  it("keeps the posts' picks and the highlights' picks apart", () => {
    const posts = toggle(select(initialSaved(), { kind: "profile", username: "sample.user" }), "p1");
    const highlights = togglePick([], "17900000000000002");
    expect([posts.picked, highlights]).toEqual([["p1"], ["17900000000000002"]]);
  });

  it("reads the picked highlights in pick order, telling how far it is", async () => {
    const read: string[] = [];
    const progress: string[] = [];
    const outcome = await readHighlights(["c", "a", "b"], async (id) => (read.push(id), { type: "nothing" }), {
      stillWanted: () => true,
      onProgress: (index, total) => progress.push(`${index}/${total}`),
    });
    expect([outcome, read, progress]).toEqual(["read", ["c", "a", "b"], ["1/3", "2/3", "3/3"]]);
  });

  it("stops at Instagram's sign-in page or its slow down, reading nothing after it", async () => {
    for (const push of ["signedOut", "rateLimited"] as const) {
      const read: string[] = [];
      const answers: HighlightResult[] = [{ type: "stories", count: 2 }, { type: push }];
      const outcome = await readHighlights(["a", "b", "c", "d", "e"], async (id) => (read.push(id), answers.shift() ?? { type: "nothing" }), {
        stillWanted: () => true,
        onProgress: () => undefined,
      });
      expect([outcome, read]).toEqual([push, ["a", "b"]]);
    }
  });

  it("reads nothing more once it is called off, and its last answer counts for nothing", async () => {
    let wanted = true;
    const read: string[] = [];
    const outcome = await readHighlights(
      ["a", "b", "c"],
      async (id) => {
        read.push(id);
        wanted = false;
        return { type: "signedOut" };
      },
      { stillWanted: () => wanted, onProgress: () => undefined },
    );
    expect([outcome, read]).toEqual(["cancelled", ["a"]]);
  });

  it("loads the picked highlights one at a time, in pick order, then stops", () => {
    expect(nextLoad(["c", "a"], 0)).toEqual({ id: "c", index: 1, total: 2 });
    expect(nextLoad(["c", "a"], 1)).toEqual({ id: "a", index: 2, total: 2 });
    expect(nextLoad(["c", "a"], 2)).toBeNull();
  });
});

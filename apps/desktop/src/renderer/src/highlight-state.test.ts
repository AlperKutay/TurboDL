import { describe, expect, it } from "vitest";
import { nextLoad, togglePick } from "./highlight-state";
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

  it("loads the picked highlights one at a time, in pick order, then stops", () => {
    expect(nextLoad(["c", "a"], 0)).toEqual({ id: "c", index: 1, total: 2 });
    expect(nextLoad(["c", "a"], 1)).toEqual({ id: "a", index: 2, total: 2 });
    expect(nextLoad(["c", "a"], 2)).toBeNull();
  });
});

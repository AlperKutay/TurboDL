import { describe, expect, it } from "vitest";
import { saveOptionsProblem, type ProfileSaveOptions } from "@turbodl/shared";
import { PROMPT_TTL_MS, Prompts, WAIT_PRESETS, promptKeyboard, promptText, type ListPrompt, type ProfilePrompt } from "../../src/main/telegram/prompts";

const ALL: ProfileSaveOptions = { posts: true, highlights: true, tagged: true, photos: true, videos: true };

function make() {
  let now = 1_000;
  const prompts = new Prompts({ now: () => now });
  return { prompts, advance: (ms: number) => (now += ms) };
}

function press(p: Prompts, id: string, key: string) {
  return p.press(`p:${id}:${key}`);
}

describe("prompts", () => {
  it("profile prompt starts from the defaults", () => {
    const { prompts } = make();
    const p = prompts.openProfile("nasa", { ...ALL, videos: false }, true);
    expect(p.options).toEqual({ ...ALL, videos: false });
    expect(promptText(p)).toContain("@nasa");
    expect(promptText(p)).toContain("Signed in");
    const labels = promptKeyboard(p).flat().map((b) => b.text);
    expect(labels).toEqual(expect.arrayContaining(["✓ Posts", "Videos", "Start", "Cancel"]));
    expect(labels).not.toContain("✓ Videos");
  });

  it("names the signed-in account when it is known", () => {
    const { prompts } = make();
    expect(promptText(prompts.openProfile("nasa", ALL, true, "me"))).toContain("Signed in as @me.");
    expect(promptText(prompts.openProfile("nasa", ALL, true))).toContain("Signed in.");
    expect(promptText(prompts.openList("l", ["a"], [], ALL, { min: 1, max: 3 }, true, "me"))).toContain("Signed in as @me.");
    expect(promptText(prompts.openList("l", ["a"], [], ALL, { min: 1, max: 3 }, true))).toContain("Signed in.");
  });

  it("ids differ between processes, so a stale button is expired", () => {
    const a = new Prompts({ now: () => 0 });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const b = new Prompts({ now: () => 0 });
      ids.add(b.openProfile("x", ALL, true).id);
    }
    expect(ids.size).toBeGreaterThan(15);
    const old = a.openProfile("old", ALL, true);
    for (let i = 0; i < 50; i++) {
      const b = new Prompts({ now: () => 0 });
      b.openProfile("new", ALL, true);
      expect(b.press(`p:${old.id}:start`)).toEqual({ type: "expired" });
    }
  });

  it("opening a prompt sweeps the expired ones", () => {
    const { prompts, advance } = make();
    const old = prompts.openProfile("a", ALL, true);
    advance(PROMPT_TTL_MS + 60_000);
    const fresh = prompts.openProfile("b", ALL, true);
    expect(press(prompts, old.id, "posts")).toEqual({ type: "expired" });
    expect(press(prompts, fresh.id, "posts").type).toBe("changed");
    expect((prompts as unknown as { open: Map<string, unknown> }).open.size).toBe(1);
  });

  it("signed out, Tagged starts off and is refused", () => {
    const { prompts } = make();
    const p = prompts.openProfile("nasa", ALL, false);
    expect(p.options.tagged).toBe(false);
    expect(promptText(p)).toContain("Tagged needs a sign-in.");
    expect(press(prompts, p.id, "tagged")).toEqual({ type: "refused", toast: "Tagged needs a sign-in." });
  });

  it("toggling changes the keyboard", () => {
    const { prompts } = make();
    const p = prompts.openProfile("nasa", ALL, true);
    const out = press(prompts, p.id, "posts");
    expect(out.type).toBe("changed");
    if (out.type !== "changed") return;
    expect((out.prompt as ProfilePrompt).options.posts).toBe(false);
    const labels = promptKeyboard(out.prompt).flat().map((b) => b.text);
    expect(labels).toContain("Posts");
    expect(labels).not.toContain("✓ Posts");
    const again = press(prompts, p.id, "highlights");
    if (again.type !== "changed") throw new Error("expected changed");
    expect((again.prompt as ProfilePrompt).options).toMatchObject({ posts: false, highlights: false });
  });

  it("Start with nothing to save is refused with the app's text", () => {
    const { prompts } = make();
    const none = { ...ALL, posts: false, highlights: false, tagged: false };
    const p = prompts.openProfile("nasa", none, true);
    expect(press(prompts, p.id, "start")).toEqual({ type: "refused", toast: saveOptionsProblem(none)! });
    expect(press(prompts, p.id, "posts").type).toBe("changed");
  });

  it("Start and Cancel remove the prompt", () => {
    const { prompts } = make();
    const a = prompts.openProfile("a", ALL, true);
    const b = prompts.openProfile("b", ALL, true);
    expect(press(prompts, a.id, "start").type).toBe("start");
    expect(press(prompts, a.id, "start")).toEqual({ type: "expired" });
    expect(press(prompts, b.id, "cancel").type).toBe("cancel");
    expect(press(prompts, b.id, "posts")).toEqual({ type: "expired" });
  });

  it("a prompt older than 24 hours is expired", () => {
    const { prompts, advance } = make();
    const p = prompts.openProfile("a", ALL, true);
    advance(PROMPT_TTL_MS + 1);
    expect(press(prompts, p.id, "posts")).toEqual({ type: "expired" });
  });

  it("unknown data is expired", () => {
    const { prompts } = make();
    const p = prompts.openProfile("a", ALL, true);
    for (const d of ["", "zzz", "p:nope:posts", `p:${p.id}:bogus`, `p:${p.id}`, "s:1"]) expect(prompts.press(d)).toEqual({ type: "expired" });
  });

  it("the wait button steps through the settings wait and the presets without repeats", () => {
    const { prompts } = make();
    const p = prompts.openList("l", ["a", "b"], ["bad line"], ALL, { min: 2, max: 5 }, true);
    expect(p.waits).toEqual([{ min: 2, max: 5 }, { min: 1, max: 3 }, { min: 5, max: 10 }, { min: 10, max: 20 }, { min: 30, max: 60 }]);
    const seen: string[] = [];
    for (let i = 0; i < p.waits.length + 1; i++) {
      const out = press(prompts, p.id, "wait");
      if (out.type !== "changed") throw new Error("expected changed");
      const w = (out.prompt as ListPrompt).wait;
      seen.push(`${w.min}-${w.max}`);
    }
    expect(seen).toEqual(["1-3", "5-10", "10-20", "30-60", "2-5", "1-3"]);
    expect(WAIT_PRESETS).toHaveLength(5);
    expect(prompts.openList("l", ["a"], [], ALL, { min: 7, max: 9 }, true).waits).toHaveLength(6);
  });

  it("list prompt text and Start", () => {
    const { prompts } = make();
    const p = prompts.openList("mine", ["a", "b", "c"], ["x", "y"], ALL, { min: 2, max: 5 }, false);
    const t = promptText(p);
    expect(t).toContain("List: 3 profiles");
    expect(t).toContain("2 lines weren't profiles");
    expect(t).toContain("2–5");
    expect(press(prompts, p.id, "start").type).toBe("start");
  });

  it("prompt callback_data fits in 64 bytes", () => {
    const { prompts } = make();
    let last = prompts.openProfile("a", ALL, true);
    for (let i = 0; i < 5000; i++) last = prompts.openProfile("a", ALL, true);
    const list = prompts.openList("l", ["a"], [], ALL, { min: 1, max: 2 }, true);
    for (const p of [last, list]) {
      for (const b of promptKeyboard(p).flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
    expect(last.id).not.toBe(list.id);
  });
});

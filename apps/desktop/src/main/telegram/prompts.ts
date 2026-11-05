import { effectiveSaveOptions, saveOptionsProblem, TAGGED_AVAILABLE } from "@turbodl/shared";
import type { ListWait, ProfileSaveOptions } from "@turbodl/shared";
import type { Keyboard } from "./types";

/** The waits the list prompt's button offers after the one from the settings, in minutes. */
export const WAIT_PRESETS: ListWait[] = [
  { min: 1, max: 3 },
  { min: 2, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 20 },
  { min: 30, max: 60 },
];
export const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ProfilePrompt {
  id: string;
  kind: "profile";
  name: string;
  options: ProfileSaveOptions;
  signedIn: boolean;
  createdAt: number;
}

export interface ListPrompt {
  id: string;
  kind: "list";
  listName: string;
  usernames: string[];
  skipped: string[];
  options: ProfileSaveOptions;
  wait: ListWait;
  waits: ListWait[];
  signedIn: boolean;
  createdAt: number;
}

export type Prompt = ProfilePrompt | ListPrompt;

export type PressOutcome =
  | { type: "expired" }
  | { type: "changed"; prompt: Prompt }
  | { type: "refused"; toast: string }
  | { type: "start"; prompt: Prompt }
  | { type: "cancel"; prompt: Prompt };

const TOGGLES = ["posts", "highlights", "tagged", "photos", "videos"] as const;
type Toggle = (typeof TOGGLES)[number];
const TOGGLE_LABELS: Record<Toggle, string> = { posts: "Posts", highlights: "Highlights", tagged: "Tagged", photos: "Photos", videos: "Videos" };
const TAGGED_REFUSED = "Tagged needs a sign-in.";
const SKIPPED_SHOWN = 5;

function sameWait(a: ListWait, b: ListWait): boolean {
  return a.min === b.min && a.max === b.max;
}

export class Prompts {
  private readonly open = new Map<string, Prompt>();
  private counter = 0;

  constructor(private readonly o: { now(): number }) {}

  private nextId(): string {
    this.counter += 1;
    return this.counter.toString(36);
  }

  openProfile(name: string, defaults: ProfileSaveOptions, signedIn: boolean): ProfilePrompt {
    const p: ProfilePrompt = { id: this.nextId(), kind: "profile", name, options: effectiveSaveOptions(defaults, signedIn), signedIn, createdAt: this.o.now() };
    this.open.set(p.id, p);
    return p;
  }

  openList(listName: string, usernames: string[], skipped: string[], defaults: ProfileSaveOptions, wait: ListWait, signedIn: boolean): ListPrompt {
    const waits = [wait, ...WAIT_PRESETS.filter((w) => !sameWait(w, wait))];
    const p: ListPrompt = {
      id: this.nextId(),
      kind: "list",
      listName,
      usernames,
      skipped,
      options: effectiveSaveOptions(defaults, signedIn),
      wait,
      waits,
      signedIn,
      createdAt: this.o.now(),
    };
    this.open.set(p.id, p);
    return p;
  }

  press(data: string): PressOutcome {
    const m = /^p:([0-9a-z]+):([a-z]+)$/.exec(data);
    if (!m) return { type: "expired" };
    const [, id, key] = m;
    const p = this.open.get(id);
    if (!p) return { type: "expired" };
    if (this.o.now() - p.createdAt > PROMPT_TTL_MS) {
      this.open.delete(id);
      return { type: "expired" };
    }
    if (key === "cancel") {
      this.open.delete(id);
      return { type: "cancel", prompt: p };
    }
    if (key === "start") {
      const problem = saveOptionsProblem(p.options);
      if (problem) return { type: "refused", toast: problem };
      this.open.delete(id);
      return { type: "start", prompt: p };
    }
    if (key === "wait" && p.kind === "list") {
      const at = p.waits.findIndex((w) => sameWait(w, p.wait));
      p.wait = p.waits[(at + 1) % p.waits.length];
      return { type: "changed", prompt: p };
    }
    if ((TOGGLES as readonly string[]).includes(key)) {
      const t = key as Toggle;
      if (t === "tagged" && (!p.signedIn || !TAGGED_AVAILABLE)) return { type: "refused", toast: TAGGED_REFUSED };
      p.options = { ...p.options, [t]: !p.options[t] };
      return { type: "changed", prompt: p };
    }
    return { type: "expired" };
  }
}

function signInLine(p: Prompt): string {
  return p.signedIn ? "Signed in." : "Signed out: Tagged needs a sign-in.";
}

export function promptText(p: Prompt): string {
  if (p.kind === "profile") return `@${p.name} — what should TurboDL save?\n${signInLine(p)}`;
  const n = p.usernames.length;
  const lines = [`List: ${n} ${n === 1 ? "profile" : "profiles"}`];
  if (p.skipped.length > 0) {
    const shown = p.skipped.slice(0, SKIPPED_SHOWN).map((s) => (s.length > 60 ? `${s.slice(0, 59)}…` : s));
    const more = p.skipped.length > SKIPPED_SHOWN ? `, and ${p.skipped.length - SKIPPED_SHOWN} more` : "";
    const count = p.skipped.length;
    lines.push(`${count} ${count === 1 ? "line wasn't a profile" : "lines weren't profiles"}: ${shown.join(", ")}${more}`);
  }
  lines.push(signInLine(p), `Wait between profiles: ${waitLabel(p.wait)}`);
  return lines.join("\n");
}

function waitLabel(w: ListWait): string {
  return `${w.min}–${w.max} min`;
}

export function promptKeyboard(p: Prompt): Keyboard {
  const btn = (key: Toggle) => ({ text: `${p.options[key] ? "✓ " : ""}${TOGGLE_LABELS[key]}`, callback_data: `p:${p.id}:${key}` });
  const top = [btn("posts"), btn("highlights"), ...(TAGGED_AVAILABLE ? [btn("tagged")] : [])];
  const rows: Keyboard = [top, [btn("photos"), btn("videos")]];
  if (p.kind === "list") rows.push([{ text: `Wait ${waitLabel(p.wait)}`, callback_data: `p:${p.id}:wait` }]);
  rows.push([
    { text: "Start", callback_data: `p:${p.id}:start` },
    { text: "Cancel", callback_data: `p:${p.id}:cancel` },
  ]);
  return rows;
}

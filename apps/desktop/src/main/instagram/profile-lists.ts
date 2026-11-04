import {
  PROFILE_LIST_MAX,
  SLOW_DOWN_WAIT_MINUTES,
  profileName,
  waitProblem,
  type Job,
  type JobProgress,
  type ListRowState,
  type ListState,
  type ListWait,
  type ProfileListRow,
  type ProfileListView,
  type ProfileSaveOptions,
  type Result,
} from "@turbodl/shared";
import { isPlanWarning } from "../jobs/instagram-job";
import { profileShowedNothing } from "./profile-service";

/** One profile run as a job: resolves with the ended job and how many files it fetched; `cancel` stops it. */
export interface ProfileRun {
  ended: Promise<{ job: Job; fetched: number }>;
  cancel(): void;
  progress(listener: (p: JobProgress) => void): void;
}

export interface ProfileListsDeps {
  runProfile(username: string, options: ProfileSaveOptions): ProfileRun;
  /** resolves after `ms`; rejects (or resolves) at once when `signal` aborts */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** 0…1 */
  random(): number;
  /** persisted list; null when none or unreadable */
  load(): ProfileListView | null;
  save(list: ProfileListView | null): void;
  onChange(list: ProfileListView | null): void;
  /** the list finished, or stopped by itself (Instagram's slow-downs, its sign-out) */
  notify(text: string): void;
  /** items the profile's backups have saved in all, from the Profiles index; undefined when it has no entry */
  savedTotal(username: string): number | undefined;
}

const MINUTE = 60_000;
/** slow-downs in a row that stop the list; profiles in a row that showed nothing, taken as one */
const IN_A_ROW = 3;
const RATE_LIMITED = "Instagram asked TurboDL to slow down 3 times in a row. Continue later.";
const SIGNED_OUT = "Instagram signed TurboDL out. Sign in, then continue.";
const STOPPED_RATE_LIMITED = "Profile list stopped: Instagram asked TurboDL to slow down 3 times in a row.";
const STOPPED_SIGNED_OUT = "Profile list stopped: Instagram signed TurboDL out.";
export const UNFINISHED = "Close the list that is there first.";
export const STOP_FIRST = "Stop the list first.";
const NO_LIST = "There is no list.";
const NO_PROFILES = "The list has no profiles.";
const NOT_A_NAME = "The list holds something that isn't a profile's name.";
const TOO_MANY = `A list can hold at most ${PROFILE_LIST_MAX.toLocaleString("en-US")} profiles.`;
/** the list goes on by itself in these */
const ACTIVE: ReadonlySet<ListState> = new Set(["running", "waiting", "slowedDown"]);
/** Continue runs these on */
const RESUMABLE: ReadonlySet<ListState> = new Set(["stopped", "rateLimited", "signedOut"]);
const LIST_STATES: ReadonlySet<string> = new Set<ListState>(["running", "waiting", "slowedDown", "stopped", "signedOut", "rateLimited", "finished"]);
const ROW_STATES: ReadonlySet<string> = new Set<ListRowState>(["waiting", "running", "done", "skipped", "failed"]);
const OPTION_KEYS: readonly (keyof ProfileSaveOptions)[] = ["posts", "highlights", "tagged", "photos", "videos"];

/**
 * A list's profiles as `profileName()` gives them (lowercased, repeats dropped), or why they can't make a list: they
 * may come from outside the app (the renderer, an API client).
 */
export function listNames(usernames: unknown): { names: string[] } | { error: string } {
  if (!Array.isArray(usernames) || usernames.length === 0) return { error: NO_PROFILES };
  const names = new Set<string>();
  for (const typed of usernames as unknown[]) {
    if (typeof typed !== "string") return { error: NOT_A_NAME };
    const name = profileName(typed);
    if (!name) return { error: `"${typed}" isn't a profile.` };
    names.add(name);
  }
  if (names.size > PROFILE_LIST_MAX) return { error: TOO_MANY };
  return { names: [...names] };
}

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v);
const isText = (v: unknown) => typeof v === "string";
const isTime = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

function isRow(v: unknown): boolean {
  return (
    isFields(v) &&
    typeof v.username === "string" &&
    // as the app stores them: profileName()'s own
    profileName(v.username) === v.username &&
    typeof v.state === "string" &&
    ROW_STATES.has(v.state) &&
    optional(v.note, isText) &&
    optional(v.files, isCount) &&
    optional(v.fetched, isCount)
  );
}

/** Whether a stored list has a list's shape: the file may be old, edited by hand or broken. */
export function isProfileListView(v: unknown): v is ProfileListView {
  if (!isFields(v)) return false;
  const { name, rows, index, state, nextAt, message, options, wait, progress } = v;
  return (
    typeof name === "string" &&
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.length <= PROFILE_LIST_MAX &&
    rows.every(isRow) &&
    isCount(index) &&
    (index as number) <= rows.length &&
    typeof state === "string" &&
    LIST_STATES.has(state) &&
    optional(nextAt, isTime) &&
    optional(message, isText) &&
    isFields(options) &&
    OPTION_KEYS.every((key) => typeof options[key] === "boolean") &&
    isFields(wait) &&
    waitProblem({ min: wait.min, max: wait.max }) === null &&
    optional(progress, (p) => isFields(p) && isTime(p.done) && optional(p.total, isTime) && optional(p.note, isText))
  );
}

/** How a row's run ended, for the list. */
type Outcome =
  | { type: "done"; files?: number; fetched: number; note?: string }
  | { type: "skipped" | "failed" | "nothing"; note: string }
  | { type: "slowedDown" | "signedOut" | "stopped" };

/**
 * The app's one list of profiles to back up: each in turn as an ordinary profile backup, with a random wait between
 * them (drawn once, stored as `nextAt`), going on by itself through Instagram's slow-downs (15 minutes, then the same
 * profile again; the 3rd in a row stops it) and past profiles it can't back up. It never holds Instagram's backup slot
 * or read slot in its own waits: only its profile runs do. Every change is told, and saved but for the running profile's
 * progress; a list loaded after a restart is stopped, and goes on only when continued.
 */
export class ProfileLists {
  private list: ProfileListView | null;
  /** slow-downs in a row (no row ended between them) */
  private slowDowns = 0;
  /** rows in a row that showed nothing */
  private nothings = 0;
  /** the row run again after the wait its showing nothing (the 3rd in a row) brought */
  private retried: number | null = null;
  /** stops the list's run: its wait, or its profile */
  private halt: AbortController | null = null;
  private running: Promise<void> | null = null;
  private run: ProfileRun | null = null;

  constructor(private readonly deps: ProfileListsDeps) {
    const stored: unknown = deps.load();
    // the app checks the file's list before; one that isn't a list never runs all the same
    const loaded = isProfileListView(stored) ? structuredClone(stored) : null;
    if (loaded) {
      for (const row of loaded.rows) if (row.state === "running") row.state = "waiting";
      delete loaded.progress;
      if (ACTIVE.has(loaded.state)) {
        loaded.state = "stopped";
        delete loaded.message;
      }
      this.bringNear(loaded);
    }
    this.list = loaded;
  }

  view(): ProfileListView | null {
    return this.list && structuredClone(this.list);
  }

  start(o: { name: string; usernames: string[]; options: ProfileSaveOptions; wait: ListWait }): Result {
    if (this.list && this.list.state !== "finished") return { ok: false, error: UNFINISHED };
    this.list = {
      name: o.name,
      rows: o.usernames.map((username) => ({ username, state: "waiting" })),
      index: 0,
      state: "running",
      options: { ...o.options },
      wait: { ...o.wait },
    };
    this.recount();
    this.changed();
    this.go();
    return { ok: true };
  }

  /** Ends the wait or the running profile's backup; resolves once the list has stopped. */
  async stop(): Promise<void> {
    if (!this.list || !ACTIVE.has(this.list.state)) return;
    this.halt?.abort();
    try {
      this.run?.cancel();
    } catch {
      // its job has ended already: the list stops before the next profile
    }
    await this.running;
  }

  /** Runs a stopped list on from its row, after the rest of a wait drawn before it stopped. */
  continue(): Result {
    const list = this.list;
    if (!list) return { ok: false, error: NO_LIST };
    if (!RESUMABLE.has(list.state)) return { ok: false, error: list.state === "finished" ? "The list has finished." : "The list is running." };
    // the user's go-ahead starts the counts over (they are lost in a restart anyway)
    this.recount();
    this.bringNear(list);
    const ahead = list.nextAt !== undefined && list.nextAt > this.deps.now();
    if (!ahead) delete list.nextAt;
    list.state = ahead ? "waiting" : "running";
    delete list.message;
    this.changed();
    this.go();
    return { ok: true };
  }

  /** Forgets a list that isn't going on by itself. */
  close(): Result {
    if (!this.list) return { ok: false, error: NO_LIST };
    if (ACTIVE.has(this.list.state)) return { ok: false, error: STOP_FIRST };
    this.list = null;
    this.recount();
    this.deps.save(null);
    this.deps.onChange(null);
    return { ok: true };
  }

  private go(): void {
    const halt = new AbortController();
    this.halt = halt;
    const running = this.steps(halt.signal)
      .catch((err: unknown) => this.broke(err))
      .finally(() => {
        if (this.halt === halt) {
          this.halt = null;
          this.running = null;
        }
      });
    this.running = running;
  }

  /** The list's run: each row from `index`, after its wait, until the list ends or stops. */
  private async steps(signal: AbortSignal): Promise<void> {
    const list = this.list!;
    for (;;) {
      // a last row that ended as Stop came finishes the list all the same
      if (list.index >= list.rows.length) return this.finish(list);
      if (signal.aborted) return this.stopped(list);
      const ms = (list.nextAt ?? 0) - this.deps.now();
      if (ms > 0) {
        if (list.state !== "waiting" && list.state !== "slowedDown") {
          list.state = "waiting";
          this.changed();
        }
        try {
          await this.deps.wait(ms, signal);
        } catch (err) {
          if (!signal.aborted) throw err;
        }
        continue;
      }
      if (!this.settle(list, await this.runRow(list))) return;
    }
  }

  /** Runs the list's row as a profile backup, to its end. */
  private async runRow(list: ProfileListView): Promise<Outcome> {
    const row = list.rows[list.index];
    row.state = "running";
    list.state = "running";
    delete list.nextAt;
    delete list.message;
    delete list.progress;
    this.changed();
    let ended: { job: Job; fetched: number };
    try {
      const run = this.deps.runProfile(row.username, list.options);
      this.run = run;
      run.progress((p) => {
        if (this.run !== run) return;
        list.progress = { done: p.done, ...(p.total !== undefined ? { total: p.total } : {}), ...(p.note !== undefined ? { note: p.note } : {}) };
        // told, not saved: a list loaded later drops its progress anyway
        this.deps.onChange(this.view());
      });
      ended = await run.ended;
    } catch (err) {
      return { type: "failed", note: err instanceof Error ? err.message : String(err) };
    } finally {
      this.run = null;
    }
    return this.outcome(row.username, ended);
  }

  /** What a profile's ended job means for its row. */
  private outcome(username: string, { job, fetched }: { job: Job; fetched: number }): Outcome {
    if (job.state === "done") {
      const files = this.deps.savedTotal(username);
      const note = job.warnings.filter((w) => !isPlanWarning(w)).at(-1);
      return { type: "done", ...(files !== undefined ? { files } : {}), fetched, ...(note !== undefined ? { note } : {}) };
    }
    if (job.state === "cancelled") return { type: "stopped" };
    const error = job.error ?? "The backup failed.";
    switch (job.reason) {
      case "private":
        return { type: "skipped", note: error };
      case "rateLimited":
        return { type: "slowedDown" };
      case "signInRequired":
        return { type: "signedOut" };
      case "error":
        // the page's text names the profile as its address does: lowercased
        if (error === profileShowedNothing(username.toLowerCase())) return { type: "nothing", note: error };
    }
    return { type: "failed", note: error };
  }

  /** Puts a row's outcome on the list; whether the list goes on by itself. */
  private settle(list: ProfileListView, outcome: Outcome): boolean {
    const row = list.rows[list.index];
    delete list.progress;
    switch (outcome.type) {
      case "stopped":
        row.state = "waiting";
        list.state = "stopped";
        this.changed();
        return false;
      case "signedOut":
        row.state = "waiting";
        list.state = "signedOut";
        list.message = SIGNED_OUT;
        this.changed();
        this.deps.notify(STOPPED_SIGNED_OUT);
        return false;
      case "slowedDown":
        return this.slowDown(list, row);
      case "nothing":
        // run again after a wait, it showed nothing again: not Instagram pushing back
        if (this.retried === list.index) return this.next(list, row, { state: "skipped", note: outcome.note });
        this.nothings++;
        if (this.nothings < IN_A_ROW) return this.next(list, row, { state: "skipped", note: outcome.note }, false);
        // three in a row: Instagram pushing back looks the same
        this.retried = list.index;
        return this.slowDown(list, row);
      case "done":
        return this.next(list, row, { state: "done", ...(outcome.files !== undefined ? { files: outcome.files } : {}), fetched: outcome.fetched, ...(outcome.note !== undefined ? { note: outcome.note } : {}) });
      case "skipped":
      case "failed":
        return this.next(list, row, { state: outcome.type, note: outcome.note });
    }
  }

  /** Instagram's slow-down: 15 minutes, then the same row; the 3rd in a row stops the list. */
  private slowDown(list: ProfileListView, row: ProfileListRow): boolean {
    row.state = "waiting";
    this.slowDowns++;
    if (this.slowDowns >= IN_A_ROW) {
      list.state = "rateLimited";
      list.message = RATE_LIMITED;
      delete list.nextAt;
      this.changed();
      this.deps.notify(STOPPED_RATE_LIMITED);
      return false;
    }
    const at = this.deps.now() + SLOW_DOWN_WAIT_MINUTES * MINUTE;
    list.state = "slowedDown";
    list.nextAt = at;
    list.message = `Instagram asked TurboDL to slow down — going on at ${clockTime(at)}.`;
    this.changed();
    return true;
  }

  /**
   * The row has ended: the next one, after the list's random wait (each row has one, a skipped one too, but the last).
   * A row that ended counts slow-downs anew, and profiles that showed nothing too, unless it is one of them (`resetNothings` false).
   */
  private next(list: ProfileListView, row: ProfileListRow, ended: Omit<ProfileListRow, "username">, resetNothings = true): boolean {
    const { username } = row;
    list.rows[list.index] = { username, ...ended };
    this.slowDowns = 0;
    if (resetNothings) this.nothings = 0;
    this.retried = null;
    list.index++;
    if (list.index < list.rows.length) {
      const { min, max } = list.wait;
      const ms = Math.round((min + this.deps.random() * (max - min)) * MINUTE);
      if (ms > 0) {
        list.state = "waiting";
        list.nextAt = this.deps.now() + ms;
      }
    }
    this.changed();
    return true;
  }

  private stopped(list: ProfileListView): void {
    for (const row of list.rows) if (row.state === "running") row.state = "waiting";
    list.state = "stopped";
    delete list.message;
    delete list.progress;
    this.changed();
  }

  private finish(list: ProfileListView): void {
    list.state = "finished";
    delete list.nextAt;
    delete list.message;
    delete list.progress;
    this.changed();
    const count = (state: ProfileListRow["state"]) => list.rows.filter((r) => r.state === state).length;
    const failed = count("failed");
    this.deps.notify(`Profile list finished: ${count("done")} backed up, ${count("skipped")} skipped${failed ? `, ${failed} failed` : ""}.`);
  }

  /** Something the list's run didn't expect: the list stops rather than stalling as if it ran. */
  private broke(err: unknown): void {
    console.error("The profile list stopped:", err);
    if (this.list && ACTIVE.has(this.list.state)) this.stopped(this.list);
  }

  private recount(): void {
    this.slowDowns = 0;
    this.nothings = 0;
    this.retried = null;
  }

  /** A stored time to go on at, no later than the list's longest wait (15 minutes at least) from now: a clock that was wrong doesn't stall it. */
  private bringNear(list: ProfileListView): void {
    const latest = this.deps.now() + Math.max(list.wait.max, SLOW_DOWN_WAIT_MINUTES) * MINUTE;
    if (list.nextAt !== undefined && list.nextAt > latest) list.nextAt = latest;
  }

  private changed(): void {
    this.deps.save(this.view());
    this.deps.onChange(this.view());
  }
}

/** HH:MM, local time. */
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

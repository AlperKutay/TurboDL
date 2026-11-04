import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PROFILE_LIST_MAX, parseProfileList, type ApiLaunch, type Job, type JobOptions, type JobRequest, type ListRequest, type ListState, type ProfileListView } from "@turbodl/shared";
import { HELP, parseArgs, type Command } from "./args";
import { ApiClient, ApiError, ping } from "./client";
import { connect, readApiFile, userDataDir, type Connection } from "./discover";
import { EXIT, combineExit, exitCodeOf, listExitCode } from "./exit";
import { createOutput, type Output } from "./output";

/** What the command needs from the process it runs in. */
export interface CliIo {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** stderr is a terminal */
  tty: boolean;
  /** printed by `--version` */
  version: string;
  /** Ctrl+C; returns the unsubscribe */
  onInterrupt(handler: () => void): () => void;
  spawn(launch: ApiLaunch): void;
  /** the clock; real timers when absent. `signal` may end a wait early. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  now?(): number;
  /** reads a text file (UTF-8); the disk when absent */
  readFile?(file: string): Promise<string>;
}

const QUIT = "TurboDL quit.";
/** How long a cut stream waits for api.json to name an app that answers: a port change cuts streams, then rewrites the file. */
const RECONNECT_MS = 5000;
const POLL_MS = 250;
/** how often a followed profile list is read */
const LIST_POLL_MS = 2000;
/** the list goes on by itself in these */
const LIST_GOES_ON: ReadonlySet<ListState> = new Set(["running", "waiting", "slowedDown"]);
const LIST_TOO_MANY = `A list can hold at most ${PROFILE_LIST_MAX.toLocaleString("en-US")} profiles.`;
/** the most characters the API takes for a list's name */
const LIST_NAME_MAX = 255;

interface Ctx {
  out: Output;
  dir: string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  onInterrupt(handler: () => void): () => void;
  /** replaced when a followed stream finds the app on another port */
  client: ApiClient;
}

type JobsCommand = Extract<Command, { type: "get" | "add" }>;
type ListCommand = Extract<Command, { type: "profileList" }>;

/** The app named by api.json once it answers, within RECONNECT_MS; no new start. Null at once when `gaveUp()`. */
async function findApp(ctx: Ctx, gaveUp: () => boolean): Promise<Connection | null> {
  const start = ctx.now();
  for (;;) {
    const file = readApiFile(ctx.dir);
    if (file && file.port !== null) {
      const c = { port: file.port, token: file.token };
      if (await ping(c)) return c;
    }
    if (gaveUp() || ctx.now() - start >= RECONNECT_MS) return null;
    await ctx.sleep(POLL_MS);
  }
}

interface Followed {
  id: string;
  /** this command cancelled it (Ctrl+C) */
  cancelledHere: boolean;
}

/**
 * Follows jobs to their end together; Ctrl+C cancels them, a second Ctrl+C gives up at once. A stream that closes
 * before the end is followed again once, on the port api.json names, unless `reconnects` is false.
 */
class Follower {
  private readonly followed: Followed[] = [];
  private presses = 0;
  private quitShown = false;
  private readonly abort = new AbortController();
  private readonly off: () => void;
  private giveUp: () => void = () => undefined;
  private readonly gaveUp: Promise<number>;

  constructor(
    private readonly ctx: Ctx,
    private readonly reconnects = true,
  ) {
    this.gaveUp = new Promise((resolve) => {
      this.giveUp = () => resolve(EXIT.interrupted);
    });
    this.off = ctx.onInterrupt(() => this.interrupt());
  }

  /** Ctrl+C was pressed */
  get interrupted(): boolean {
    return this.presses > 0;
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  /** Follows one more job; after a Ctrl+C it is cancelled at once. */
  add(id: string): void {
    if (this.followed.some((f) => f.id === id)) return;
    const f = { id, cancelledHere: false };
    this.followed.push(f);
    if (this.interrupted) this.cancel(f);
  }

  private interrupt(): void {
    this.presses++;
    if (this.presses === 1) {
      for (const f of this.followed) this.cancel(f);
      return;
    }
    this.abort.abort();
    this.giveUp();
  }

  private cancel(f: Followed): void {
    f.cancelledHere = true;
    this.ctx.client.cancel(f.id).catch(() => undefined);
  }

  /** The combined exit code once every job ended, or 130 at a second Ctrl+C. */
  async run(): Promise<number> {
    if (this.followed.length === 0) return this.interrupted ? EXIT.interrupted : EXIT.ok;
    const all = Promise.all(this.followed.map((f) => this.one(f))).then(combineExit);
    return Promise.race([all, this.gaveUp]);
  }

  dispose(): void {
    this.off();
    this.abort.abort();
  }

  private async one(f: Followed): Promise<number> {
    let end = await this.stream(f.id);
    if (end === "unknown") {
      this.ctx.out.error(`No job ${f.id}.`);
      return EXIT.failed;
    }
    if (end === undefined && !this.stopped && this.reconnects) {
      // once: the app may have moved to another port; the stream replays the job first
      const c = await this.reconnect();
      if (c) {
        this.ctx.client = new ApiClient(c);
        // a Ctrl+C while the stream was cut sent its cancel to the old port
        if (f.cancelledHere) this.cancel(f);
        end = await this.stream(f.id);
      }
    }
    if (end && end !== "unknown") return exitCodeOf(end, f.cancelledHere);
    if (!this.stopped && !this.quitShown) {
      this.quitShown = true;
      this.ctx.out.error(QUIT);
    }
    return EXIT.unreachable;
  }

  /** The job at its `end`; undefined when the stream closed first; "unknown" when the app doesn't know the job. */
  private async stream(id: string): Promise<Job | undefined | "unknown"> {
    try {
      for await (const e of this.ctx.client.events(id, this.abort.signal)) {
        if (this.stopped) return undefined;
        this.ctx.out.event(e);
        if (e.type === "end") return e.job;
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 404) return "unknown";
    }
    return undefined;
  }

  private reconnect(): Promise<Connection | null> {
    return findApp(this.ctx, () => this.stopped);
  }
}

/**
 * Follows the profile list this command starts until it no longer goes on by itself, a line per profile as it ends.
 * Ctrl+C stops the list (the app keeps it, to continue), a second Ctrl+C gives up at once. A list read that finds the
 * app gone looks for it again once, on the port api.json names.
 */
class ListFollower {
  private presses = 0;
  /** the app has the list: a Ctrl+C now stops it */
  private started = false;
  /** the stop a Ctrl+C sent: the list as it stopped, or null when the stop didn't get through */
  private stopping: Promise<ProfileListView | null> | undefined;
  private stopAnswered = false;
  private over = false;
  private readonly printed = new Set<string>();
  /** ends the wait between two reads early (a Ctrl+C, or the command is over) */
  private pausing: AbortController | undefined;
  private giveUp: () => void = () => undefined;
  private readonly gaveUp: Promise<number>;
  private readonly off: () => void;

  constructor(private readonly ctx: Ctx) {
    this.gaveUp = new Promise((resolve) => {
      this.giveUp = () => resolve(EXIT.interrupted);
    });
    this.off = ctx.onInterrupt(() => this.interrupt());
  }

  private interrupt(): void {
    this.presses++;
    if (this.presses > 1) return this.giveUp();
    if (this.started) this.stop();
    this.pausing?.abort();
  }

  /** The wait between two reads of the list. */
  private async pause(): Promise<void> {
    const pausing = new AbortController();
    this.pausing = pausing;
    try {
      await this.ctx.sleep(LIST_POLL_MS, pausing.signal);
    } finally {
      if (this.pausing === pausing) this.pausing = undefined;
    }
  }

  private stop(): void {
    this.stopping ??= this.ctx.client.stopList().catch(() => null);
  }

  /** The exit code once the list stopped going on, or 130 at a second Ctrl+C. */
  async run(request: ListRequest): Promise<number> {
    try {
      return await Promise.race([this.follow(request), this.gaveUp]);
    } finally {
      this.over = true;
      this.pausing?.abort();
      this.off();
    }
  }

  private async follow(request: ListRequest): Promise<number> {
    const { out } = this.ctx;
    let list: ProfileListView | null | "quit";
    try {
      list = await this.ctx.client.startList(request);
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 400)) throw err;
      // 409: another list is unfinished; 400: the app won't start this one (e.g. tagged posts only, signed out)
      out.error(err.status === 409 ? err.message : `TurboDL refused the list: ${err.message}`);
      return err.status === 409 ? EXIT.failed : EXIT.usage;
    }
    this.started = true;
    if (this.presses > 0) this.stop();
    for (;;) {
      if (this.over) return EXIT.interrupted;
      if (list === "quit") {
        out.error(QUIT);
        return EXIT.unreachable;
      }
      if (!list) {
        out.error("The list was closed in TurboDL.");
        return EXIT.stopped;
      }
      for (const row of list.rows) {
        if ((row.state === "done" || row.state === "skipped" || row.state === "failed") && !this.printed.has(row.username)) {
          this.printed.add(row.username);
          out.listRow(row);
        }
      }
      if (!LIST_GOES_ON.has(list.state)) {
        out.listEnd(list);
        return listExitCode(list, this.stopping !== undefined);
      }
      if (this.stopping && !this.stopAnswered) {
        this.stopAnswered = true;
        list = (await this.stopping) ?? (await this.read());
        continue;
      }
      await this.pause();
      // a Ctrl+C during the wait: the stop's answer comes next
      if (this.stopping && !this.stopAnswered) continue;
      list = await this.read();
    }
  }

  /** The app's list; "quit" when the app is gone and api.json names none that answers. */
  private async read(): Promise<ProfileListView | null | "quit"> {
    try {
      return await this.ctx.client.currentList();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 0) throw err;
    }
    // once: the app may have moved to another port
    const c = await findApp(this.ctx, () => this.over);
    if (!c) return "quit";
    this.ctx.client = new ApiClient(c);
    // a Ctrl+C while the app was away sent its stop to the old port
    if (this.presses > 0) await this.ctx.client.stopList().catch(() => null);
    try {
      return await this.ctx.client.currentList();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 0) throw err;
      return "quit";
    }
  }
}

/** The file's profiles, or the exit code once it said why there are none to back up; lines that aren't profiles are warned about. */
async function readProfiles(io: CliIo, out: Output, file: string): Promise<string[] | number> {
  let text: string;
  try {
    text = io.readFile ? await io.readFile(file) : await fsp.readFile(file, "utf8");
  } catch {
    out.error(`Couldn't read ${file}.`);
    return EXIT.usage;
  }
  const list = parseProfileList(text);
  for (const line of list.invalid) out.warning(`Line ${line.line} isn't a profile: ${line.text}`);
  if (list.tooMany) {
    out.error(LIST_TOO_MANY);
    return EXIT.usage;
  }
  if (list.usernames.length === 0) {
    out.error("The file holds no profiles.");
    return EXIT.usage;
  }
  return list.usernames;
}

/** What starts the list: every option spelled out, and the file's name for the app's panel. */
function listRequest(cmd: ListCommand, profiles: string[]): ListRequest {
  return { profiles, options: cmd.options, wait: cmd.wait, name: path.basename(cmd.file).slice(0, LIST_NAME_MAX) };
}

function requestFor(cmd: JobsCommand, url: string): JobRequest {
  const request: JobRequest = { url };
  if (cmd.dir !== undefined) request.dir = cmd.dir;
  if (cmd.name !== undefined) request.name = cmd.name;
  if (Object.keys(cmd.options).length > 0) request.options = cmd.options;
  return request;
}

/** One job per link, in order; a refused link cancels the jobs already made and gives the exit code instead. */
async function createJobs(ctx: Ctx, cmd: JobsCommand, follower?: Follower): Promise<Job[] | number> {
  const jobs: Job[] = [];
  for (const url of cmd.urls) {
    if (follower?.interrupted) break;
    try {
      const job = await ctx.client.createJob(requestFor(cmd, url));
      jobs.push(job);
      follower?.add(job.id);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      await Promise.all(jobs.map((j) => ctx.client.cancel(j.id).catch(() => null)));
      const refused = err.status === 400;
      ctx.out.error(refused ? `TurboDL refused ${url}: ${err.message}` : err.message);
      return refused ? EXIT.usage : EXIT.unreachable;
    }
  }
  return jobs;
}

/** Follows what `start` hands the follower, unless `start` already gives an exit code. */
async function follow(ctx: Ctx, start: (f: Follower) => Promise<number | undefined>, o: { reconnect?: boolean } = {}): Promise<number> {
  const follower = new Follower(ctx, o.reconnect ?? true);
  try {
    const code = await start(follower);
    return code ?? (await follower.run());
  } finally {
    follower.dispose();
  }
}

async function command(ctx: Ctx, cmd: Exclude<Command, { type: "help" | "version" | "profileList" }>): Promise<number> {
  const { out, client } = ctx;
  switch (cmd.type) {
    case "get":
      return follow(ctx, async (f) => {
        const jobs = await createJobs(ctx, cmd, f);
        return typeof jobs === "number" ? jobs : undefined;
      });
    case "posts":
      // no reconnect: the stream sends only live events after the job's snapshot, so posts sent while it was cut are gone
      return follow(
        ctx,
        async (f) => {
          const options: JobOptions = { postsOnly: true };
          if (cmd.since !== undefined) options.since = cmd.since;
          if (cmd.limit !== undefined) options.limit = cmd.limit;
          const jobs = await createJobs(ctx, { type: "get", urls: [cmd.url], options, json: cmd.json }, f);
          return typeof jobs === "number" ? jobs : undefined;
        },
        { reconnect: false },
      );
    case "wait":
      return follow(ctx, async (f) => {
        for (const id of cmd.ids) f.add(id);
        return undefined;
      });
    case "add": {
      const jobs = await createJobs(ctx, cmd);
      if (typeof jobs === "number") return jobs;
      for (const job of jobs) out.added(job);
      return EXIT.ok;
    }
    case "list":
      out.list(await client.jobs());
      return EXIT.ok;
    case "status": {
      const job = await client.job(cmd.id);
      if (!job) {
        out.error(`No job ${cmd.id}.`);
        return EXIT.failed;
      }
      out.job(job);
      return EXIT.ok;
    }
    case "cancel": {
      let code: number = EXIT.ok;
      for (const id of cmd.ids) {
        const job = await client.cancel(id);
        if (job) out.job(job);
        else {
          out.error(`No job ${id}.`);
          code = EXIT.failed;
        }
      }
      return code;
    }
    case "instagram":
      if (cmd.action === "login") {
        const result = await client.instagramLogin();
        out.instagram(result);
        return result.signedIn ? EXIT.ok : EXIT.signIn;
      }
      if (cmd.action === "logout") {
        await client.instagramLogout();
        out.instagram({ signedIn: false });
        return EXIT.ok;
      }
      out.instagram((await client.info()).instagram);
      return EXIT.ok;
  }
}

/** Runs one turbodl command line and resolves with its exit code; never throws. */
export async function run(io: CliIo): Promise<number> {
  const cmd = parseArgs(io.argv, io.cwd);
  if ("error" in cmd) {
    const out = createOutput({ json: io.argv.includes("--json"), stdout: io.stdout, stderr: io.stderr, tty: io.tty });
    out.error(cmd.error);
    io.stderr.write("Run turbodl --help.\n");
    return EXIT.usage;
  }
  if (cmd.type === "help") {
    io.stdout.write(HELP);
    return EXIT.ok;
  }
  if (cmd.type === "version") {
    io.stdout.write(`turbodl ${io.version}\n`);
    return EXIT.ok;
  }

  const out = createOutput({ json: cmd.json, stdout: io.stdout, stderr: io.stderr, tty: io.tty });
  const sleep = io.sleep ? io.sleep.bind(io) : (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }).catch(() => undefined);
  const now = io.now ? io.now.bind(io) : Date.now;
  const dir = userDataDir(io.env, io.platform, io.home);
  try {
    // a list's file is read before TurboDL is looked for: a file that can't be a list needs no app
    const profiles = cmd.type === "profileList" ? await readProfiles(io, out, cmd.file) : [];
    if (typeof profiles === "number") return profiles;
    const conn = await connect({ dir, spawn: (launch) => io.spawn(launch), ping, sleep, now });
    if ("error" in conn) {
      out.error(conn.error);
      return EXIT.unreachable;
    }
    const ctx: Ctx = { out, dir, sleep, now, onInterrupt: (h) => io.onInterrupt(h), client: new ApiClient(conn) };
    if (cmd.type === "profileList") return await new ListFollower(ctx).run(listRequest(cmd, profiles));
    return await command(ctx, cmd);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    return err instanceof ApiError ? EXIT.unreachable : EXIT.failed;
  } finally {
    out.close();
  }
}

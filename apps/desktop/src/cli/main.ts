import type { ApiLaunch, Job, JobRequest } from "@turbodl/shared";
import { HELP, parseArgs, type Command } from "./args";
import { ApiClient, ApiError, ping } from "./client";
import { connect, readApiFile, userDataDir, type Connection } from "./discover";
import { EXIT, combineExit, exitCodeOf } from "./exit";
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
  /** the clock; real timers when absent */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const QUIT = "TurboDL quit.";
/** How long a cut stream waits for api.json to name an app that answers: a port change cuts streams, then rewrites the file. */
const RECONNECT_MS = 5000;
const POLL_MS = 250;

interface Ctx {
  out: Output;
  dir: string;
  sleep(ms: number): Promise<void>;
  now(): number;
  onInterrupt(handler: () => void): () => void;
  /** replaced when a followed stream finds the app on another port */
  client: ApiClient;
}

type JobsCommand = Extract<Command, { type: "get" | "add" }>;

interface Followed {
  id: string;
  /** this command cancelled it (Ctrl+C) */
  cancelledHere: boolean;
}

/** Follows jobs to their end together; Ctrl+C cancels them, a second Ctrl+C gives up at once. */
class Follower {
  private readonly followed: Followed[] = [];
  private presses = 0;
  private quitShown = false;
  private readonly abort = new AbortController();
  private readonly off: () => void;
  private giveUp: () => void = () => undefined;
  private readonly gaveUp: Promise<number>;

  constructor(private readonly ctx: Ctx) {
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
    if (end === undefined && !this.stopped) {
      // once: the app may have moved to another port; the stream replays the job first
      const c = await this.reconnect();
      if (c) {
        this.ctx.client = new ApiClient(c);
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

  /** The app named by api.json once it answers, within RECONNECT_MS; no new start. */
  private async reconnect(): Promise<Connection | null> {
    const start = this.ctx.now();
    for (;;) {
      const file = readApiFile(this.ctx.dir);
      if (file && file.port !== null) {
        const c = { port: file.port, token: file.token };
        if (await ping(c)) return c;
      }
      if (this.stopped || this.ctx.now() - start >= RECONNECT_MS) return null;
      await this.ctx.sleep(POLL_MS);
    }
  }
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
async function follow(ctx: Ctx, start: (f: Follower) => Promise<number | undefined>): Promise<number> {
  const follower = new Follower(ctx);
  try {
    const code = await start(follower);
    return code ?? (await follower.run());
  } finally {
    follower.dispose();
  }
}

async function command(ctx: Ctx, cmd: Exclude<Command, { type: "help" | "version" }>): Promise<number> {
  const { out, client } = ctx;
  switch (cmd.type) {
    case "get":
      return follow(ctx, async (f) => {
        const jobs = await createJobs(ctx, cmd, f);
        return typeof jobs === "number" ? jobs : undefined;
      });
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
  const sleep = io.sleep ? io.sleep.bind(io) : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const now = io.now ? io.now.bind(io) : Date.now;
  const dir = userDataDir(io.env, io.platform, io.home);
  try {
    const conn = await connect({ dir, spawn: (launch) => io.spawn(launch), ping, sleep, now });
    if ("error" in conn) {
      out.error(conn.error);
      return EXIT.unreachable;
    }
    const ctx: Ctx = { out, dir, sleep, now, onInterrupt: (h) => io.onInterrupt(h), client: new ApiClient(conn) };
    return await command(ctx, cmd);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    return err instanceof ApiError ? EXIT.unreachable : EXIT.failed;
  } finally {
    out.close();
  }
}

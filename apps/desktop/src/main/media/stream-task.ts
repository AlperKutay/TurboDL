import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { splitExt, uniqueName, type DownloadRecord, type StreamTrackState } from "@turbodl/shared";
import { HttpDownloadTask, TEMP_SUFFIX, describeError } from "../engine/download-task";
import { downloadFragments } from "../engine/fragments";
import { abortError, isAbortError } from "../engine/http";
import { SpeedMeter, estimateEta } from "../engine/speed";
import type { TaskHandle } from "../task";
import { canSkipMux, mux, type MuxInput } from "./mux";
import type { Resolved, TrackPlan } from "./resolve";
import { DEFAULT_FORMAT } from "./ytdlp";

export const MUX_SUFFIX = ".turbodl-mux";

export function trackFileName(filename: string, index: number): string {
  return `${filename}.turbodl-t${index}`;
}

/** Every temp file an unfinished stream download may have left (removed with "delete files"). */
export function streamTempFiles(record: DownloadRecord): string[] {
  const files: string[] = [];
  (record.stream?.tracks ?? []).forEach((track, i) => {
    for (const name of new Set([trackFileName(record.filename, i), track.file?.filename ?? trackFileName(record.filename, i)])) {
      files.push(path.join(record.dir, name), path.join(record.dir, name + TEMP_SUFFIX));
    }
  });
  files.push(path.join(record.dir, record.filename + MUX_SUFFIX));
  return files;
}

export interface StreamTaskOptions {
  connections: () => number;
  ffmpegPath: string | null;
  resolve: (record: DownloadRecord, signal: AbortSignal) => Promise<Resolved>;
  /** yt-dlp's own downloader, for streams TurboDL does not handle (live, unusual protocols) */
  fallback: (record: DownloadRecord) => TaskHandle;
  idleTimeoutMs?: number;
  retryBaseMs?: number;
}

/** Downloads a video's tracks with TurboDL's own engine, then joins them with ffmpeg. */
export class StreamTask implements TaskHandle {
  private controller: AbortController | null = null;
  private pauseRequested = false;
  private stage: "resolve" | "download" | "mux" | null = null;
  private sub: HttpDownloadTask | null = null;
  private delegate: TaskHandle | null = null;
  private fragmentsRunning = false;
  private readonly meter = new SpeedMeter();

  constructor(
    readonly record: DownloadRecord,
    private readonly opts: StreamTaskOptions,
  ) {}

  get note(): string | undefined {
    if (this.delegate) return this.delegate.note;
    if (this.stage === "resolve") return "Getting video addresses…";
    if (this.stage === "mux") return "Joining…";
    return this.sub?.note;
  }

  get speed(): number {
    if (this.delegate) return this.delegate.speed;
    if (this.sub) return this.sub.speed;
    return this.fragmentsRunning ? this.meter.bytesPerSecond : 0;
  }

  get eta(): number | null {
    if (this.delegate) return this.delegate.eta;
    const size = this.record.size;
    return size === null ? null : estimateEta(size - this.record.received, this.speed);
  }

  get connections(): number {
    if (this.delegate) return this.delegate.connections;
    if (this.sub) return this.sub.connections;
    return this.fragmentsRunning ? Math.max(1, this.opts.connections()) : 0;
  }

  pause(): void {
    this.pauseRequested = true;
    this.delegate?.pause();
    this.sub?.pause();
    this.controller?.abort();
  }

  async start(): Promise<void> {
    const rec = this.record;
    const info = rec.stream;
    rec.status = "downloading";
    rec.error = undefined;
    if (!info) {
      rec.status = "error";
      rec.error = "Stream information is missing.";
      return;
    }
    this.pauseRequested = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.meter.reset();
    const timer = setInterval(() => this.updateTotals(), 250);
    try {
      this.stage = "resolve";
      const resolved = await this.opts.resolve(rec, signal);
      if (this.pauseRequested) throw abortError();
      if (resolved.type === "fallback") {
        this.stage = null;
        await this.runFallback();
        return;
      }
      await this.syncTracks(resolved.tracks);
      this.stage = "download";
      await fsp.mkdir(rec.dir, { recursive: true });
      for (let i = 0; i < resolved.tracks.length; i++) {
        if (this.pauseRequested) throw abortError();
        const state = info.tracks[i];
        if (state.done) continue;
        const plan = resolved.tracks[i];
        if (plan.source.kind === "file") await this.runFileTrack(i, plan, state);
        else await this.runFragmentTrack(i, plan, state, signal);
        state.done = true;
      }
      if (this.pauseRequested) throw abortError();
      this.stage = "mux";
      await this.finish(resolved.tracks.some((t) => t.source.kind === "fragments"), signal);
    } catch (err) {
      if (this.pauseRequested || isAbortError(err)) rec.status = "paused";
      else {
        rec.status = "error";
        rec.error = describeError(err);
      }
    } finally {
      clearInterval(timer);
      // read through this.record: finish() sets "completed" where TypeScript's narrowing of `rec` cannot see it
      if (this.record.status !== "completed") this.updateTotals();
      this.stage = null;
      this.sub = null;
      this.delegate = null;
      this.fragmentsRunning = false;
      this.controller = null;
    }
  }

  private async syncTracks(plans: TrackPlan[]): Promise<void> {
    const rec = this.record;
    const info = rec.stream!;
    const same =
      info.tracks.length === plans.length &&
      plans.every((p, i) => info.tracks[i].id === p.id && (p.source.kind === "file" ? !info.tracks[i].frag : !info.tracks[i].file));
    if (!same) {
      // different formats than last time: what was downloaded belongs to something else
      for (const file of streamTempFiles(rec)) await fsp.rm(file, { force: true }).catch(() => undefined);
      info.tracks = plans.map((p) => ({ id: p.id, role: p.role, ext: p.ext, done: false }));
    }
    plans.forEach((p, i) => {
      const state = info.tracks[i];
      state.role = p.role;
      state.ext = p.ext;
      if (p.source.kind === "file" && !state.file) {
        state.file = {
          id: `${rec.id}-t${i}`,
          kind: "http",
          url: p.source.url,
          filename: trackFileName(rec.filename, i),
          dir: rec.dir,
          category: rec.category,
          size: p.source.size,
          received: 0,
          status: "queued",
          headers: {},
          resumable: false,
          segments: [],
          viaScheduler: false,
          createdAt: Date.now(),
        };
      }
    });
    this.updateTotals();
  }

  private async runFileTrack(index: number, plan: TrackPlan, state: StreamTrackState): Promise<void> {
    if (plan.source.kind !== "file" || !state.file) return;
    const rec = this.record;
    const sub = state.file;
    const name = trackFileName(rec.filename, index);
    if (sub.status === "completed" && existsSync(path.join(rec.dir, sub.filename))) return;
    // fresh addresses on every start: YouTube links expire after a few hours
    sub.url = plan.source.url;
    sub.headers = { ...plan.headers };
    sub.dir = rec.dir;
    sub.filename = name;
    await fsp.rm(path.join(rec.dir, name), { force: true });
    const task = new HttpDownloadTask(sub, {
      maxConnections: this.opts.connections,
      chunkSize: plan.source.chunkSize,
      idleTimeoutMs: this.opts.idleTimeoutMs,
      retryBaseMs: this.opts.retryBaseMs,
    });
    this.sub = task;
    try {
      await task.start();
    } finally {
      this.sub = null;
    }
    if (this.pauseRequested || sub.status === "paused") throw abortError();
    if (sub.status !== "completed") throw new Error(sub.error ?? "The download could not be completed.");
  }

  private async runFragmentTrack(index: number, plan: TrackPlan, state: StreamTrackState, signal: AbortSignal): Promise<void> {
    if (plan.source.kind !== "fragments") return;
    const rec = this.record;
    const file = path.join(rec.dir, trackFileName(rec.filename, index));
    const progress = (state.frag ??= { count: plan.source.plan.fragments.length, initDone: false, done: 0, bytes: 0 });
    const onDisk = existsSync(file) ? (await fsp.stat(file)).size : -1;
    if (onDisk < progress.bytes) Object.assign(progress, { initDone: false, done: 0, bytes: 0 });
    this.fragmentsRunning = true;
    try {
      await downloadFragments({
        path: file,
        plan: plan.source.plan,
        progress,
        headers: plan.headers,
        cookieHost: plan.cookieHost,
        signal,
        connections: this.opts.connections,
        onBytes: (n) => this.meter.add(n),
        idleTimeoutMs: this.opts.idleTimeoutMs,
        retryBaseMs: this.opts.retryBaseMs,
      });
    } finally {
      this.fragmentsRunning = false;
    }
  }

  private async finish(fromFragments: boolean, signal: AbortSignal): Promise<void> {
    const rec = this.record;
    const info = rec.stream!;
    const inputs: MuxInput[] = info.tracks.map((t, i) => ({
      path: path.join(rec.dir, t.file ? t.file.filename : trackFileName(rec.filename, i)),
      role: t.role,
      ext: t.ext,
    }));
    let produced: string;
    let ext: string;
    if (canSkipMux(inputs, info.output, fromFragments)) {
      produced = inputs[0].path;
      ext = inputs[0].ext;
    } else {
      produced = path.join(rec.dir, rec.filename + MUX_SUFFIX);
      ext = await mux(this.opts.ffmpegPath, inputs, produced, info.output, signal);
    }
    const [base] = splitExt(rec.filename);
    const finalName = uniqueName(`${base}.${ext}`, (n) => existsSync(path.join(rec.dir, n)));
    await fsp.rename(produced, path.join(rec.dir, finalName));
    for (const input of inputs) if (input.path !== produced) await fsp.rm(input.path, { force: true });
    const { size } = await fsp.stat(path.join(rec.dir, finalName));
    rec.filename = finalName;
    rec.size = size;
    rec.received = size;
    info.tracks = [];
    rec.status = "completed";
    rec.completedAt = Date.now();
  }

  private async runFallback(): Promise<void> {
    const rec = this.record;
    const info = rec.stream!;
    const origin = info.origin;
    const shadow: DownloadRecord = {
      ...rec,
      kind: "ytdlp",
      stream: undefined,
      segments: [],
      received: 0,
      size: null,
      url: origin.type === "ytdlp" ? origin.pageUrl : origin.url,
      ytdlp: {
        formatSelector: origin.type === "ytdlp" ? origin.formatSelector : DEFAULT_FORMAT,
        audioOnly: info.output === "mp3",
        ...(origin.type === "ytdlp" && origin.cookies ? { cookies: origin.cookies } : {}),
      },
    };
    const task = this.opts.fallback(shadow);
    this.delegate = task;
    const mirror = setInterval(() => {
      rec.received = shadow.received;
      rec.size = shadow.size;
    }, 250);
    try {
      await task.start();
    } finally {
      clearInterval(mirror);
    }
    rec.status = shadow.status;
    rec.error = shadow.error;
    rec.received = shadow.received;
    rec.size = shadow.size;
    if (shadow.status === "completed") {
      rec.filename = shadow.filename;
      rec.dir = shadow.dir;
      rec.completedAt = shadow.completedAt;
      info.tracks = [];
    }
  }

  private updateTotals(): void {
    if (this.delegate) return;
    const tracks = this.record.stream?.tracks ?? [];
    if (tracks.length === 0) return;
    let size = 0;
    let known = true;
    let received = 0;
    for (const t of tracks) {
      if (t.file) {
        received += t.file.received;
        if (t.file.size === null) known = false;
        else size += t.file.size;
      } else if (t.frag) {
        received += t.frag.bytes;
        if (t.done) size += t.frag.bytes;
        else if (t.frag.done > 0 && t.frag.count > 0) size += Math.round((t.frag.bytes / t.frag.done) * t.frag.count);
        else known = false;
      } else {
        known = false;
      }
    }
    this.record.received = received;
    this.record.size = known ? size : null;
  }
}

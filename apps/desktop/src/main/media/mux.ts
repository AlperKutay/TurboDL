import { spawn } from "node:child_process";
import { abortError } from "../engine/http";
import { killTree } from "./ytdlp-task";

export type TrackRole = "video" | "audio" | "av";

export interface MuxInput {
  path: string;
  role: TrackRole;
  /** extension of the downloaded track ("mp4", "m4a", "webm", "ts") */
  ext: string;
}

export type MuxFormat = "mp4" | "matroska" | "mp3";

export function muxArgs(inputs: MuxInput[], output: string, format: MuxFormat): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const input of inputs) args.push("-i", input.path);
  if (format === "mp3") {
    args.push("-vn", "-c:a", "libmp3lame", "-q:a", "2");
  } else {
    inputs.forEach((input, n) => {
      if (input.role === "video") args.push("-map", `${n}:v:0`);
      else if (input.role === "audio") args.push("-map", `${n}:a:0`);
      else args.push("-map", `${n}:v:0?`, "-map", `${n}:a:0?`);
    });
    args.push("-c", "copy");
    if (format === "mp4" && inputs.some((i) => i.ext === "ts")) args.push("-bsf:a", "aac_adtstoasc");
  }
  args.push("-f", format, output);
  return args;
}

/** A single progressive mp4 with sound and picture is already the final file. */
export function canSkipMux(inputs: MuxInput[], target: "mp4" | "mp3", fromFragments: boolean): boolean {
  return target === "mp4" && !fromFragments && inputs.length === 1 && inputs[0].role === "av" && inputs[0].ext === "mp4";
}

export function runFfmpeg(ffmpeg: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const onAbort = () => killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(abortError());
      else if (code === 0) resolve();
      else {
        const line = stderr.trim().split(/\r?\n/).pop() ?? "";
        reject(new Error(`Joining failed: ${line || `ffmpeg exit code ${code}`}`));
      }
    });
  });
}

/** Writes the joined file to `output` and returns its extension; mkv when mp4 cannot hold the codecs. */
export async function mux(ffmpeg: string | null, inputs: MuxInput[], output: string, target: "mp4" | "mp3", signal: AbortSignal): Promise<"mp4" | "mkv" | "mp3"> {
  if (!ffmpeg) throw new Error("ffmpeg not found; could not join the video.");
  if (target === "mp3") {
    await runFfmpeg(ffmpeg, muxArgs(inputs, output, "mp3"), signal);
    return "mp3";
  }
  try {
    await runFfmpeg(ffmpeg, muxArgs(inputs, output, "mp4"), signal);
    return "mp4";
  } catch (err) {
    if (signal.aborted) throw err;
    await runFfmpeg(ffmpeg, muxArgs(inputs, output, "matroska"), signal);
    return "mkv";
  }
}

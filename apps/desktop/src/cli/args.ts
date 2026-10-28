import path from "node:path";
import { parseIsoTime, type JobOptions } from "@turbodl/shared";

/** One parsed turbodl command line. */
export type Command =
  | { type: "get" | "add"; urls: string[]; dir?: string; name?: string; options: JobOptions; json: boolean }
  | { type: "posts"; url: string; since?: string; limit?: number; json: boolean }
  | { type: "list"; json: boolean }
  | { type: "status"; id: string; json: boolean }
  | { type: "wait" | "cancel"; ids: string[]; json: boolean }
  | { type: "instagram"; action: "login" | "logout" | "status"; json: boolean }
  | { type: "help" }
  | { type: "version" };

/** The `--help` text: every command and option. */
export const HELP = `Usage: turbodl <command> [options]

Commands:
  get <link...>          Download the links and wait until they finish
  add <link...>          Queue the links and return at once
  posts <link>           List an Instagram profile's or post's posts, saving nothing
  list                   List the jobs
  status <id>            Show one job
  wait <id...>           Wait until the jobs finish
  cancel <id...>         Cancel the jobs
  instagram login        Sign in to Instagram
  instagram logout       Sign out of Instagram
  instagram status       Show the Instagram sign-in state
  help                   Show this text

Options (get and add):
  -d, --dir <folder>     Save into this folder
  --name <file>          Name the file (one link only)
  --audio                Download the audio only
  --max-height <px>      Pick a video of at most this height
  --highlights           Include highlights (Instagram profiles)
  --highlights-only      Download only the highlights
  --collection <name>    Download a Saved collection (repeatable)
  --all-collections      Download every Saved collection

Options (posts):
  --since <time>         Only posts taken at or after this ISO 8601 time
  --limit <n>            At most this many posts (1 to 100000)

Options (every command):
  --json                 Print JSON instead of text
  -h, --help             Show this text
  -v, --version          Show the version

Exit codes: 0 ok, 1 failed, 2 usage, 3 sign-in needed, 4 rate limited,
5 app unreachable, 6 stopped, 130 interrupted.
`;

const VALUE_OPTIONS = new Set(["-d", "--dir", "--name", "--max-height", "--collection", "--since", "--limit"]);
const FLAG_OPTIONS = new Set(["--audio", "--highlights", "--highlights-only", "--all-collections", "--json"]);
const COMMANDS = new Set(["get", "add", "list", "status", "wait", "cancel", "instagram", "posts"]);

/** Reads the command line; returns the command or `{ error }` for a usage mistake. */
export function parseArgs(argv: string[], cwd: string): Command | { error: string } {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      version = true;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const opt = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_OPTIONS.has(opt)) {
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
      if (value === undefined) return { error: `${opt} needs a value` };
      const key = opt === "-d" ? "--dir" : opt;
      values.set(key, [...(values.get(key) ?? []), value]);
    } else if (FLAG_OPTIONS.has(opt) && eq === -1) {
      flags.add(opt);
    } else {
      return { error: `unknown option "${arg}"` };
    }
  }

  if (help) return { type: "help" };
  if (version) return { type: "version" };
  if (positional.length === 0 || positional[0] === "help") return { type: "help" };

  const [command, ...rest] = positional;
  if (!COMMANDS.has(command)) return { error: `unknown command "${command}"` };
  const json = flags.has("--json");

  switch (command) {
    case "posts": {
      if (rest.length !== 1) return { error: "posts takes one link" };
      const result: Command = { type: "posts", url: rest[0], json };
      const since = values.get("--since")?.at(-1);
      if (since !== undefined) {
        const iso = parseIsoTime(since);
        if (iso === undefined) return { error: "--since needs an ISO time" };
        result.since = iso;
      }
      const limit = values.get("--limit")?.at(-1);
      if (limit !== undefined) {
        if (!/^[1-9]\d{0,5}$/.test(limit) || Number(limit) > 100_000) {
          return { error: "--limit needs a whole number from 1 to 100000" };
        }
        result.limit = Number(limit);
      }
      return result;
    }
    case "list":
      return { type: "list", json };
    case "status":
      return rest.length === 1 ? { type: "status", id: rest[0], json } : { error: "status needs one job id" };
    case "wait":
    case "cancel":
      return rest.length > 0 ? { type: command, ids: rest, json } : { error: `${command} needs a job id` };
    case "instagram":
      return rest[0] === "login" || rest[0] === "logout" || rest[0] === "status"
        ? { type: "instagram", action: rest[0], json }
        : { error: "instagram needs login, logout or status" };
  }

  if (rest.length === 0) return { error: `${command} needs at least one link` };
  const name = values.get("--name")?.at(-1);
  if (name !== undefined && rest.length > 1) return { error: "--name takes a single link" };

  const options: JobOptions = {};
  const height = values.get("--max-height")?.at(-1);
  if (height !== undefined) {
    if (!/^[1-9]\d*$/.test(height)) return { error: "--max-height needs a whole number of pixels" };
    options.maxHeight = Number(height);
  }
  if (flags.has("--audio")) options.audio = true;
  if (flags.has("--highlights") && flags.has("--highlights-only")) {
    return { error: "--highlights and --highlights-only can't both be set" };
  }
  if (flags.has("--highlights")) options.highlights = true;
  if (flags.has("--highlights-only")) options.highlightsOnly = true;
  const collections = values.get("--collection");
  if (collections && flags.has("--all-collections")) {
    return { error: "--collection and --all-collections can't both be set" };
  }
  if (collections) options.collections = collections;
  if (flags.has("--all-collections")) options.allCollections = true;

  const result: Command = { type: command as "get" | "add", urls: rest, options, json };
  const dir = values.get("--dir")?.at(-1);
  if (dir !== undefined) result.dir = path.resolve(cwd, dir);
  if (name !== undefined) result.name = name;
  return result;
}

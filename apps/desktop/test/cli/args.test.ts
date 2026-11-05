import path from "node:path";
import { describe, expect, it } from "vitest";
import { TAGGED_AVAILABLE } from "@turbodl/shared";
import { HELP, helpText, parseArgs } from "../../src/cli/args";

const cwd = path.resolve("work");
const err = (argv: string[]) => parseArgs(argv, cwd);

describe("parseArgs commands", () => {
  it("reads get and add", () => {
    expect(parseArgs(["get", "https://a/x", "https://a/y"], cwd)).toEqual({
      type: "get",
      urls: ["https://a/x", "https://a/y"],
      options: {},
      json: false
    });
    expect(parseArgs(["add", "https://a/x"], cwd)).toEqual({ type: "add", urls: ["https://a/x"], options: {}, json: false });
  });

  it("reads list, status, wait, cancel", () => {
    expect(parseArgs(["list"], cwd)).toEqual({ type: "list", json: false });
    expect(parseArgs(["status", "j1"], cwd)).toEqual({ type: "status", id: "j1", json: false });
    expect(parseArgs(["wait", "a", "b"], cwd)).toEqual({ type: "wait", ids: ["a", "b"], json: false });
    expect(parseArgs(["cancel", "a"], cwd)).toEqual({ type: "cancel", ids: ["a"], json: false });
  });

  it("reads instagram actions", () => {
    for (const action of ["login", "logout", "status"] as const) {
      expect(parseArgs(["instagram", action], cwd)).toEqual({ type: "instagram", action, json: false });
    }
  });

  it("reads help and version", () => {
    for (const a of [[], ["-h"], ["--help"], ["help"]]) expect(parseArgs(a, cwd)).toEqual({ type: "help" });
    for (const a of [["-v"], ["--version"]]) expect(parseArgs(a, cwd)).toEqual({ type: "version" });
  });

  it("accepts --json anywhere", () => {
    expect(parseArgs(["--json", "list"], cwd)).toEqual({ type: "list", json: true });
    expect(parseArgs(["status", "--json", "j1"], cwd)).toEqual({ type: "status", id: "j1", json: true });
    expect(parseArgs(["get", "https://a/x", "--json"], cwd)).toMatchObject({ type: "get", json: true });
    expect(parseArgs(["instagram", "status", "--json"], cwd)).toEqual({ type: "instagram", action: "status", json: true });
  });
});

describe("parseArgs options", () => {
  it("resolves --dir against cwd", () => {
    expect(parseArgs(["get", "u", "-d", "rel"], cwd)).toMatchObject({ dir: path.resolve(cwd, "rel") });
    expect(parseArgs(["get", "u", "--dir=x"], cwd)).toMatchObject({ dir: path.resolve(cwd, "x") });
    expect(parseArgs(["get", "u", "--dir", "x"], cwd)).toMatchObject({ dir: path.resolve(cwd, "x") });
  });

  it("reads job options", () => {
    expect(parseArgs(["get", "u", "--name", "f.mp4", "--audio", "--max-height", "720", "--highlights"], cwd)).toEqual({
      type: "get",
      urls: ["u"],
      name: "f.mp4",
      options: { audio: true, maxHeight: 720, highlights: true },
      json: false
    });
    expect(parseArgs(["add", "u", "--max-height=1080", "--highlights-only"], cwd)).toMatchObject({
      options: { maxHeight: 1080, highlightsOnly: true }
    });
    expect(parseArgs(["add", "u", "--all-collections"], cwd)).toMatchObject({ options: { allCollections: true } });
  });

  it("collects repeated --collection", () => {
    expect(parseArgs(["get", "u", "--collection", "a", "--collection=b"], cwd)).toMatchObject({
      options: { collections: ["a", "b"] }
    });
  });
});

describe("parseArgs errors", () => {
  it("rejects unknown commands and options", () => {
    expect(err(["frob"])).toEqual({ error: 'unknown command "frob"' });
    expect(err(["list", "--frob"])).toEqual({ error: 'unknown option "--frob"' });
    expect(err(["get", "u", "-z"])).toEqual({ error: 'unknown option "-z"' });
  });

  it("rejects missing values", () => {
    expect(err(["get", "u", "--dir"])).toEqual({ error: "--dir needs a value" });
    expect(err(["get", "u", "-d"])).toEqual({ error: "-d needs a value" });
    expect(err(["get", "u", "--name", "--json"])).toEqual({ error: "--name needs a value" });
  });

  it("rejects bad link counts", () => {
    expect(err(["get"])).toEqual({ error: "get needs at least one link" });
    expect(err(["add", "--json"])).toEqual({ error: "add needs at least one link" });
    expect(err(["get", "a", "b", "--name", "x"])).toEqual({ error: "--name takes a single link" });
  });

  it("rejects bad option values and conflicts", () => {
    for (const v of ["0", "-3", "abc", "7.5", "1e3"]) {
      expect(err(["get", "u", `--max-height=${v}`])).toEqual({ error: "--max-height needs a whole number of pixels" });
    }
    expect(err(["get", "u", "--highlights", "--highlights-only"])).toEqual({
      error: "--highlights and --highlights-only can't both be set"
    });
    expect(err(["get", "u", "--collection", "a", "--all-collections"])).toEqual({
      error: "--collection and --all-collections can't both be set"
    });
  });

  it("maps the profile save options", () => {
    expect(parseArgs(["get", "u", "--no-posts", "--highlights"], cwd)).toMatchObject({
      options: { posts: false, highlights: true }
    });
    expect(parseArgs(["add", "u", "--tagged"], cwd)).toMatchObject({ options: { tagged: true } });
    expect(parseArgs(["add", "u", "--no-posts", "--tagged"], cwd)).toMatchObject({
      options: { posts: false, tagged: true }
    });
    expect(parseArgs(["get", "u", "--photos-only"], cwd)).toMatchObject({ options: { videos: false } });
    expect(parseArgs(["get", "u", "--videos-only"], cwd)).toMatchObject({ options: { photos: false } });
    const only = parseArgs(["get", "u", "--no-posts", "--highlights-only"], cwd);
    expect(only).toMatchObject({ options: { highlightsOnly: true } });
    expect((only as { options: object }).options).not.toHaveProperty("posts");
  });

  it("rejects bad profile save option combinations", () => {
    expect(err(["get", "u", "--photos-only", "--videos-only"])).toEqual({
      error: "--photos-only and --videos-only can't both be set"
    });
    expect(err(["get", "u", "--no-posts"])).toEqual({ error: "--no-posts needs --highlights or --tagged" });
  });

  it("rejects bad ids and instagram actions", () => {
    expect(err(["status"])).toEqual({ error: "status needs one job id" });
    expect(err(["status", "a", "b"])).toEqual({ error: "status needs one job id" });
    expect(err(["wait"])).toEqual({ error: "wait needs a job id" });
    expect(err(["cancel"])).toEqual({ error: "cancel needs a job id" });
    expect(err(["instagram"])).toEqual({ error: "instagram needs login, logout or status" });
    expect(err(["instagram", "nope"])).toEqual({ error: "instagram needs login, logout or status" });
  });
});

describe("tagged posts, on or off in this version", () => {
  it("takes --tagged and lists it while tagged posts are available", () => {
    expect(TAGGED_AVAILABLE).toBe(true);
    expect(parseArgs(["get", "u", "--tagged"], cwd, { tagged: true })).toMatchObject({ options: { tagged: true } });
    expect(helpText(true)).toContain("--tagged");
    expect(helpText(true)).toBe(HELP);
  });

  it("refuses --tagged as a usage mistake and leaves it out of the help when they aren't", () => {
    const off = { tagged: false };
    expect(parseArgs(["get", "u", "--tagged"], cwd, off)).toEqual({ error: "--tagged isn't available in this version" });
    expect(parseArgs(["add", "u", "--no-posts", "--tagged"], cwd, off)).toEqual({ error: "--tagged isn't available in this version" });
    expect(parseArgs(["get", "u", "--no-posts"], cwd, off)).toEqual({ error: "--no-posts needs --highlights" });
    expect(parseArgs(["get", "u", "--no-posts", "--highlights"], cwd, off)).toMatchObject({ options: { posts: false, highlights: true } });
    expect(helpText(false)).not.toContain("--tagged");
    expect(helpText(false)).toContain("--no-posts");
  });
});

describe("HELP", () => {
  it("lists every command and option", () => {
    for (const word of [
      "get", "add", "list", "status", "wait", "cancel", "instagram", "telegram", "help",
      "--dir", "--name", "--audio", "--max-height", "--highlights", "--highlights-only",
      "--no-posts", "--tagged", "--photos-only", "--videos-only",
      "--collection", "--all-collections", "--json", "--version"
    ]) {
      expect(HELP).toContain(word);
    }
  });
});

describe("parseArgs get --from-file", () => {
  const WAIT = "Waits are whole minutes from 0 to 1440, the most at least the least.";
  const all = { posts: true, highlights: false, tagged: false, photos: true, videos: true };

  it("reads a list of profiles with every save option and the default wait", () => {
    expect(parseArgs(["get", "--from-file", "list.txt"], cwd)).toEqual({
      type: "profileList",
      file: path.resolve(cwd, "list.txt"),
      wait: { min: 2, max: 5 },
      options: all,
      json: false
    });
    expect(parseArgs(["get", "--from-file=sub/l.txt", "--json"], cwd)).toMatchObject({ file: path.resolve(cwd, "sub/l.txt"), json: true });
  });

  it("reads --wait as min-max or a single number of minutes", () => {
    expect(parseArgs(["get", "--from-file", "l.txt", "--wait", "3"], cwd)).toMatchObject({ wait: { min: 3, max: 3 } });
    expect(parseArgs(["get", "--from-file", "l.txt", "--wait=0-10"], cwd)).toMatchObject({ wait: { min: 0, max: 10 } });
    expect(parseArgs(["get", "--from-file", "l.txt", "--wait", "1440"], cwd)).toMatchObject({ wait: { min: 1440, max: 1440 } });
  });

  it("answers a bad --wait with the app's own message", () => {
    for (const w of ["5-2", "1441", "0-1441", "abc", "1.5", "2-", "-3", "2-5-7", ""]) {
      expect(err(["get", "--from-file", "l.txt", `--wait=${w}`])).toEqual({ error: WAIT });
    }
  });

  it("sends every save option from the flags, highlights only when asked", () => {
    const options = (...flags: string[]) => (parseArgs(["get", "--from-file", "l.txt", ...flags], cwd) as { options: object }).options;
    expect(options("--highlights")).toEqual({ ...all, highlights: true });
    expect(options("--highlights-only")).toEqual({ ...all, posts: false, highlights: true });
    expect(options("--no-posts", "--highlights-only")).toEqual({ ...all, posts: false, highlights: true });
    expect(options("--no-posts", "--tagged", "--photos-only")).toEqual({ ...all, posts: false, tagged: true, videos: false });
    expect(options("--videos-only")).toEqual({ ...all, photos: false });
  });

  it("keeps the save options' own refusals", () => {
    expect(err(["get", "--from-file", "l.txt", "--no-posts"])).toEqual({ error: "--no-posts needs --highlights or --tagged" });
    expect(err(["get", "--from-file", "l.txt", "--photos-only", "--videos-only"])).toEqual({ error: "--photos-only and --videos-only can't both be set" });
    expect(parseArgs(["get", "--from-file", "l.txt", "--tagged"], cwd, { tagged: false })).toEqual({ error: "--tagged isn't available in this version" });
  });

  it("refuses links and the options that aren't a list's", () => {
    expect(err(["get", "https://www.instagram.com/nasa/", "--from-file", "l.txt"])).toEqual({ error: "--from-file can't be combined with links" });
    for (const [flag, ...value] of [["--dir", "out"], ["-d", "out"], ["--name", "x"], ["--audio"], ["--max-height", "720"], ["--collection", "a"], ["--all-collections"]]) {
      const shown = flag === "-d" ? "--dir" : flag;
      expect(err(["get", "--from-file", "l.txt", flag, ...value])).toEqual({ error: `--from-file can't be combined with ${shown}` });
    }
  });

  it("takes --from-file with get only and --wait with --from-file only", () => {
    expect(err(["add", "--from-file", "l.txt"])).toEqual({ error: "--from-file works only with get" });
    expect(err(["get", "https://a/x", "--wait", "3"])).toEqual({ error: "--wait needs --from-file" });
    expect(err(["get", "--from-file"])).toEqual({ error: "--from-file needs a value" });
  });

  it("lists --from-file and --wait in the help", () => {
    expect(HELP).toContain("  --from-file <txt>      Back up the Instagram profiles listed in a .txt, one after another\n");
    expect(HELP).toContain("  --wait <min>-<max>     Minutes to wait between those profiles, at random (default 2-5)\n");
  });
});

describe("parseArgs posts", () => {
  it("parses posts with since and limit", () => {
    expect(parseArgs(["posts", "https://www.instagram.com/someone/", "--since", "2026-01-02", "--limit", "25", "--json"], cwd)).toEqual({
      type: "posts",
      url: "https://www.instagram.com/someone/",
      since: "2026-01-02T00:00:00.000Z",
      limit: 25,
      json: true
    });
    expect(parseArgs(["posts", "https://a/x"], cwd)).toEqual({ type: "posts", url: "https://a/x", json: false });
  });

  it("posts takes exactly one link", () => {
    expect(err(["posts"])).toEqual({ error: "posts takes one link" });
    expect(err(["posts", "https://a/x", "https://a/y"])).toEqual({ error: "posts takes one link" });
  });

  it("rejects a bad --since", () => {
    for (const since of ["yesterday", "2026-13-01", "2026-01-01T10:00"]) {
      expect(err(["posts", "https://a/x", "--since", since])).toEqual({ error: "--since needs an ISO time" });
    }
  });

  it("rejects a bad --limit", () => {
    for (const limit of ["0", "-1", "1.5", "abc", "100001"]) {
      expect(err(["posts", "https://a/x", `--limit=${limit}`])).toEqual({ error: "--limit needs a whole number from 1 to 100000" });
    }
  });

  it("lists posts in the help", () => {
    expect(HELP).toContain("posts <link>");
    expect(HELP).toContain("--since");
  });
});

describe("parseArgs telegram", () => {
  it("reads the actions", () => {
    for (const action of ["status", "token", "pair", "unpair", "on", "off"] as const) {
      expect(parseArgs(["telegram", action], cwd)).toEqual({ type: "telegram", action, json: false });
    }
    expect(parseArgs(["telegram", "status", "--json"], cwd)).toEqual({ type: "telegram", action: "status", json: true });
  });

  it("reads a chat id", () => {
    expect(parseArgs(["telegram", "chat", "123"], cwd)).toEqual({ type: "telegram", action: "chat", chatId: 123, json: false });
    expect(parseArgs(["telegram", "chat", "123", "--json"], cwd)).toEqual({ type: "telegram", action: "chat", chatId: 123, json: true });
  });

  it("rejects a chat id that is not a whole number above 0", () => {
    const message = { error: "telegram chat needs a chat id (a whole number)" };
    for (const bad of [["chat"], ["chat", "abc"], ["chat", "1.5"], ["chat", "0"], ["chat", "12", "13"], ["chat", "99999999999999999999"]]) {
      expect(err(["telegram", ...bad])).toEqual(message);
    }
  });

  it("rejects a missing or unknown action", () => {
    const message = { error: "telegram needs status, token, chat, unpair, pair, on or off" };
    expect(err(["telegram"])).toEqual(message);
    expect(err(["telegram", "nope"])).toEqual(message);
    expect(err(["telegram", "status", "extra"])).toEqual(message);
  });

  it("is in the help text", () => {
    expect(HELP).toContain("  telegram status        Show the Telegram bot's state\n");
    expect(HELP).toContain("  telegram token         Set the bot token (typed, or piped on stdin)\n");
    expect(HELP).toContain("  telegram chat <id>     Bind the bot to this chat id\n");
    expect(HELP).toContain("  telegram pair          Show a code to send the bot, and wait until it's paired\n");
    expect(HELP).toContain("  telegram unpair        Unbind the chat\n");
    expect(HELP).toContain("  telegram on|off        Turn the bot on or off\n");
  });
});

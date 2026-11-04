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
      "get", "add", "list", "status", "wait", "cancel", "instagram", "help",
      "--dir", "--name", "--audio", "--max-height", "--highlights", "--highlights-only",
      "--no-posts", "--tagged", "--photos-only", "--videos-only",
      "--collection", "--all-collections", "--json", "--version"
    ]) {
      expect(HELP).toContain(word);
    }
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

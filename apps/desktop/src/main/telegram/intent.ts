import { parseInstagramLink, profileName } from "@turbodl/shared";
import type { TgMessage } from "./types";

export type Command = "start" | "help" | "status" | "stop" | "list";
export type Intent =
  | { type: "command"; name: Command }
  | { type: "profile"; name: string }
  | { type: "names"; names: string[] }
  | { type: "links"; urls: string[]; saved: number }
  | { type: "document"; fileId: string; fileName: string; size?: number }
  | { type: "otherFile" }
  | { type: "unknown" };

const COMMANDS = new Set<string>(["start", "help", "status", "stop", "list"]);
const isLink = (token: string): boolean => /^https?:\/\//i.test(token);

/** What the owner meant: a command, profile names, links, a .txt list of either, or something it can't read. */
export function readIntent(message: TgMessage): Intent {
  const doc = message.document;
  if (doc) {
    const fileName = doc.file_name ?? "";
    if (!/\.txt$/i.test(fileName)) return { type: "otherFile" };
    return { type: "document", fileId: doc.file_id, fileName, ...(doc.file_size !== undefined ? { size: doc.file_size } : {}) };
  }
  if (message.text === undefined) return { type: "otherFile" };
  const tokens = message.text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return { type: "unknown" };

  if (tokens[0].startsWith("/")) {
    const name = tokens[0].slice(1).replace(/@.*$/, "").toLowerCase();
    return COMMANDS.has(name) ? { type: "command", name: name as Command } : { type: "unknown" };
  }

  const names = tokens.map(profileName);
  if (names.every((n): n is string => n !== null)) {
    // every name: the list's own check refuses too many, in the app's words
    const unique = [...new Set(names)];
    return unique.length === 1 ? { type: "profile", name: unique[0] } : { type: "names", names: unique };
  }

  if (tokens.every(isLink)) {
    const urls: string[] = [];
    let saved = 0;
    for (const url of tokens) {
      const link = parseInstagramLink(url);
      if (link?.kind === "profile") return { type: "unknown" };
      if (link?.kind === "saved") saved++;
      else urls.push(url);
    }
    return { type: "links", urls, saved };
  }
  return { type: "unknown" };
}

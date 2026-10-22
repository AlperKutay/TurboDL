import path from "node:path";
import { sanitizeFilename, type InstagramItem } from "@turbodl/shared";

/** `<baseDir>/Instagram`: single links' and Saved picks' items when they aren't kept per account. */
export function instagramFolder(baseDir: string): string {
  return path.join(baseDir, "Instagram");
}

/** `<baseDir>/Instagram/<username>`: an account's posts, picked or backed up. */
export function accountFolder(baseDir: string, username: string): string {
  return path.join(baseDir, "Instagram", sanitizeFilename(username));
}

/** An account's highlights: under its folder, or beside it (`<username> · Highlights`) when not kept per account. */
export function highlightsFolder(baseDir: string, username: string, byAccount: boolean): string {
  return byAccount ? path.join(accountFolder(baseDir, username), "Highlights") : path.join(baseDir, "Instagram", sanitizeFilename(`${username} · Highlights`));
}

/** Where one picked item goes: its account's folder (its highlights' for a highlight's stories) when kept per account. */
export function itemFolder(defaultDir: string, item: InstagramItem, o: { baseDir: string; byAccount: boolean; highlight: boolean }): string {
  if (!o.byAccount || !item.owner) return defaultDir;
  return o.highlight ? highlightsFolder(o.baseDir, item.owner, true) : accountFolder(o.baseDir, item.owner);
}

import { getExtension } from "./categories";
import { filenameFromUrl } from "./filename";

const MAX_LENGTH = 2000;

/** The URL in copied text when it is a single http(s) link to a file type on the capture list. */
export function clipboardLink(text: string, extensions: string[]): string | null {
  const value = text.trim();
  if (!value || value.length > MAX_LENGTH || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const name = filenameFromUrl(value);
  const ext = name ? getExtension(name) : "";
  return ext && extensions.includes(ext) ? value : null;
}

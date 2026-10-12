import { extensionFromMime, getExtension } from "./categories";

export interface CaptureCandidate {
  url: string;
  filename?: string;
  mime?: string;
  fileSize?: number;
  byExtensionId?: string;
}

export interface CapturePolicy {
  enabled: boolean;
  extensions: string[];
  minSize: number;
  selfExtensionId: string;
}

export type CaptureDecision = "capture" | "skip" | "undecided";

function urlExtension(url: string): string {
  try {
    return getExtension(new URL(url).pathname);
  } catch {
    return "";
  }
}

/**
 * Decide whether a browser download should be handed to TurboDL.
 * "undecided" means: the filename is not known yet and neither the URL nor the
 * MIME type matches — wait for Chrome to determine the filename.
 */
export function captureDecision(c: CaptureCandidate, p: CapturePolicy): CaptureDecision {
  if (!p.enabled) return "skip";
  if (c.byExtensionId && c.byExtensionId === p.selfExtensionId) return "skip";
  let protocol: string;
  try {
    protocol = new URL(c.url).protocol;
  } catch {
    return "skip";
  }
  if (protocol !== "http:" && protocol !== "https:") return "skip";
  if (c.fileSize !== undefined && c.fileSize > 0 && c.fileSize < p.minSize) return "skip";
  const fromName = c.filename ? getExtension(c.filename) : "";
  if (fromName) return p.extensions.includes(fromName) ? "capture" : "skip";
  const guess = urlExtension(c.url) || extensionFromMime(c.mime);
  if (guess && p.extensions.includes(guess)) return "capture";
  return c.filename ? "skip" : "undecided";
}

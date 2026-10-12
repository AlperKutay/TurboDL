const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_LENGTH = 200;

export function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

export function sanitizeFilename(input: string): string {
  let name = input
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!name) return "download";
  let [base, ext] = splitExt(name);
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  if (ext.length > 20) {
    base += ext;
    ext = "";
  }
  if (base.length + ext.length > MAX_NAME_LENGTH) base = base.slice(0, MAX_NAME_LENGTH - ext.length);
  name = base + ext;
  return name;
}

/** Servers often send raw UTF-8 bytes in filename=; HTTP stacks decode them as latin1. */
function repairMojibake(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    const charset = star[1].trim().toLowerCase();
    const raw = star[2].trim().replace(/^"(.*)"$/, "$1");
    try {
      if (charset === "utf-8" || charset === "") return decodeURIComponent(raw);
      return raw.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    } catch {
      // fall back to filename=
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return repairMojibake(quoted[1].replace(/\\(.)/g, "$1"));
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) return repairMojibake(bare[1].trim());
  return null;
}

export function filenameFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const last = pathname.split("/").filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const [base, ext] = splitExt(name);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

import { filenameFromUrl, parseContentDisposition } from "@turbodl/shared";
import { HttpError, request } from "./http";

export interface ProbeResult {
  finalUrl: string;
  size: number | null;
  resumable: boolean;
  filename: string | null;
  mime: string | null;
  etag?: string;
  lastModified?: string;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Ask for byte 0 only: tells us the size, range support and the server-side name. */
export async function probe(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 20000,
): Promise<ProbeResult> {
  const res = await request(url, { headers, range: { start: 0, end: 0 }, signal, timeoutMs });
  res.body.destroy();

  let size: number | null = null;
  let resumable = false;
  if (res.status === 416) {
    const m = /bytes\s+\*\/(\d+)/i.exec(single(res.headers["content-range"]) ?? "");
    if (!m) throw new HttpError(416);
    size = Number(m[1]);
  } else if (res.status >= 400) {
    throw new HttpError(res.status);
  } else if (res.status === 206) {
    const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(single(res.headers["content-range"]) ?? "");
    if (m && m[1] !== "*") {
      size = Number(m[1]);
      resumable = true;
    }
  } else {
    const raw = single(res.headers["content-length"]);
    const len = raw === undefined ? NaN : Number(raw);
    size = Number.isFinite(len) && len >= 0 ? len : null;
  }

  const mime = single(res.headers["content-type"])?.split(";")[0].trim() || null;
  const filename = parseContentDisposition(single(res.headers["content-disposition"])) ?? filenameFromUrl(res.finalUrl);
  return {
    finalUrl: res.finalUrl,
    size,
    resumable,
    filename,
    mime,
    etag: single(res.headers.etag),
    lastModified: single(res.headers["last-modified"]),
  };
}

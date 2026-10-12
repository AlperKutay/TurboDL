export interface HttpHeader {
  name: string;
  value?: string;
}

export function headerValue(headers: HttpHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Total size: Content-Range total for partial responses, else Content-Length. */
export function sizeFromHeaders(headers: HttpHeader[] | undefined): number | undefined {
  const range = headerValue(headers, "content-range");
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    return m ? Number(m[1]) : undefined;
  }
  const length = headerValue(headers, "content-length");
  if (length === undefined) return undefined;
  const n = Number(length);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? "";
}

export function isHttpUrl(u: string | undefined): u is string {
  return !!u && /^https?:\/\//i.test(u);
}

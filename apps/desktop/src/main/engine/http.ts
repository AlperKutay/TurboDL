import http from "node:http";
import https from "node:https";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface RequestOptions {
  headers?: Record<string, string>;
  /** inclusive byte range; end null means "to the end" */
  range?: { start: number; end: number | null };
  signal?: AbortSignal;
  /** socket inactivity timeout in ms (default 30 s) */
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  body: http.IncomingMessage;
}

export function httpErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "The server requires authentication (401). The link may have expired.";
    case 403:
      return "Access denied (403). The link may have expired.";
    case 404:
      return "The server could not find the file (404). The link may have expired.";
    case 410:
      return "The file is no longer on the server (410).";
    case 416:
      return "The server could not serve the requested range (416).";
    default:
      return `Server error (${status}).`;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message ?? httpErrorMessage(status));
    this.name = "HttpError";
  }
}

export class NetworkError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export function abortError(): Error {
  const err = new Error("Cancelled.");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function wrapError(err: unknown): Error {
  if (err instanceof NetworkError || isAbortError(err)) return err as Error;
  const e = err as NodeJS.ErrnoException;
  switch (e.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new NetworkError("Server not found. Check your internet connection.", e.code);
    case "ECONNREFUSED":
      return new NetworkError("The server refused the connection.", e.code);
    case "ECONNRESET":
      return new NetworkError("The connection was lost.", e.code);
    case "ETIMEDOUT":
      return new NetworkError("The server is not responding (timeout).", e.code);
    default:
      return new NetworkError(`Connection error: ${e.message}`, e.code);
  }
}

export function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return send(url, options, options.maxRedirects ?? 10, options.headers ?? {});
}

function send(url: string, options: RequestOptions, redirectsLeft: number, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new NetworkError(`Invalid address: ${url}`));
      return;
    }
    const isHttps = target.protocol === "https:";
    if (!isHttps && target.protocol !== "http:") {
      reject(new NetworkError(`Unsupported protocol: ${target.protocol}`));
      return;
    }
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    const finalHeaders: Record<string, string> = {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "*/*",
      ...headers,
      "Accept-Encoding": "identity",
    };
    if (options.range) finalHeaders.Range = `bytes=${options.range.start}-${options.range.end ?? ""}`;

    const req = (isHttps ? https : http).request(target, {
      method: "GET",
      headers: finalHeaders,
      agent: isHttps ? httpsAgent : httpAgent,
    });
    const onAbort = () => req.destroy(abortError());
    const detach = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(options.timeoutMs ?? 30000, () => {
      req.destroy(new NetworkError("The server is not responding (timeout).", "ETIMEDOUT"));
    });
    req.on("error", (err) => {
      detach();
      reject(wrapError(err));
    });
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        res.resume();
        detach();
        if (redirectsLeft <= 0) {
          reject(new NetworkError("Too many redirects."));
          return;
        }
        const next = new URL(location, target);
        const nextHeaders = { ...headers };
        if (next.host !== target.host) {
          delete nextHeaders.Cookie;
          delete nextHeaders.cookie;
        }
        send(next.toString(), options, redirectsLeft - 1, nextHeaders).then(resolve, reject);
        return;
      }
      res.once("close", detach);
      resolve({ status, headers: res.headers, finalUrl: target.toString(), body: res });
    });
    req.end();
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

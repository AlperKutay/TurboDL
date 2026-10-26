import http from "node:http";
import type { ApiInfo, InstagramLoginResult, Job, JobEvent, JobRequest } from "@turbodl/shared";
import type { Connection } from "./discover";

/** A failed API call; status 0 means the connection itself failed. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const LOST = "Lost the connection to TurboDL.";

interface Reply {
  status: number;
  body: unknown;
}

function failure(status: number, body: unknown): ApiError {
  if (status === 403) return new ApiError(403, "TurboDL refused the key in api.json.");
  const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `TurboDL answered ${status}.`;
  return new ApiError(status, message);
}

/** A client for the local jobs API; every call rejects with an ApiError on failure. */
export class ApiClient {
  constructor(private readonly c: Connection) {}

  private options(method: string, path: string, payload?: string): http.RequestOptions {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.c.token}` };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    return { host: "127.0.0.1", port: this.c.port, method, path, headers };
  }

  private request(method: string, path: string, body?: unknown): Promise<Reply> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(this.options(method, path, payload), (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (b: Buffer) => chunks.push(b));
        res.on("error", () => reject(new ApiError(0, LOST)));
        res.on("aborted", () => reject(new ApiError(0, LOST)));
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // not JSON: keep null
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on("error", () => reject(new ApiError(0, LOST)));
      req.end(payload);
    });
  }

  private async ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.request(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.body;
    throw failure(r.status, r.body);
  }

  private async orNull(method: string, path: string): Promise<Job | null> {
    const r = await this.request(method, path);
    if (r.status === 404) return null;
    if (r.status >= 200 && r.status < 300) return (r.body as { job: Job }).job;
    throw failure(r.status, r.body);
  }

  /** GET /v1/info */
  async info(): Promise<ApiInfo> {
    return (await this.ok("GET", "/v1/info")) as ApiInfo;
  }

  /** Starts a job; a refused request rejects with the API's own message. */
  async createJob(request: JobRequest): Promise<Job> {
    return ((await this.ok("POST", "/v1/jobs", request)) as { job: Job }).job;
  }

  /** All jobs the app knows about. */
  async jobs(): Promise<Job[]> {
    return ((await this.ok("GET", "/v1/jobs")) as { jobs: Job[] }).jobs;
  }

  /** One job, or null when it is unknown. */
  job(id: string): Promise<Job | null> {
    return this.orNull("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }

  /** Cancels a job; null when it is unknown. */
  cancel(id: string): Promise<Job | null> {
    return this.orNull("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`);
  }

  /** The job's events; the iteration simply ends when the stream closes, `end` or not. */
  async *events(id: string): AsyncIterable<JobEvent> {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(this.options("GET", `/v1/jobs/${encodeURIComponent(id)}/events`), resolve);
      req.on("error", () => reject(new ApiError(0, LOST)));
      req.end();
    });
    if (res.statusCode !== 200) {
      const chunks: Buffer[] = [];
      for await (const b of res) chunks.push(b as Buffer);
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // not JSON
      }
      throw failure(res.statusCode ?? 0, body);
    }
    res.setEncoding("utf8");
    let buffer = "";
    try {
      for await (const chunk of res) {
        buffer += chunk as string;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield JSON.parse(line) as JobEvent;
        }
      }
    } catch (err) {
      // a stream cut mid-way just ends; a bad line from the app is not ours to hide
      if (err instanceof SyntaxError) throw err;
    } finally {
      res.destroy();
    }
  }

  /** Opens Instagram's sign-in in the app and resolves with the outcome. */
  async instagramLogin(): Promise<InstagramLoginResult> {
    return (await this.ok("POST", "/v1/instagram/login", {})) as InstagramLoginResult;
  }

  /** Signs the app out of Instagram. */
  async instagramLogout(): Promise<void> {
    await this.ok("POST", "/v1/instagram/logout", {});
  }
}

/** GET /v1/info within 2 s answered 200. */
export function ping(c: Connection): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: c.port, method: "GET", path: "/v1/info", headers: { Authorization: `Bearer ${c.token}` }, timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

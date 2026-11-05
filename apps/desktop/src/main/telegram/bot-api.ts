import type { Keyboard, Update } from "./types";

export type TelegramErrorKind = "unauthorized" | "conflict" | "rateLimited" | "notModified" | "notFound" | "tooLarge" | "badRequest" | "server" | "network";

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfter?: number;
  /** true only when the request certainly never reached Telegram (a connect-phase failure) */
  readonly unsent?: boolean;
  constructor(kind: TelegramErrorKind, message: string, retryAfter?: number, unsent?: boolean) {
    super(message);
    this.name = "TelegramError";
    this.kind = kind;
    this.retryAfter = retryAfter;
    if (unsent) this.unsent = true;
  }
}

const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** Whether a fetch failure happened before the request could leave (anywhere in its cause chain). */
function isConnectFailure(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && CONNECT_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every((x) => isConnectFailure(x, depth + 1))) return true;
  return isConnectFailure(e.cause, depth + 1);
}

/** Replaces every occurrence of the token, so an error text can be logged or shown. */
export function scrub(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

export interface BotApiOptions {
  token: string;
  base?: string;
  fetch?: typeof fetch;
  /** every call but getUpdates is cut off as a network error after this long (default 30 s) */
  requestTimeoutMs?: number;
  /** getUpdates is cut off this long after its own long-poll timeout (default 10 s) */
  pollGraceMs?: number;
}

interface ApiReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

function isAbort(err: unknown, signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

export class BotApi {
  private readonly token: string;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly pollGraceMs: number;

  constructor(o: BotApiOptions) {
    this.token = o.token;
    this.base = (o.base ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
    this.pollGraceMs = o.pollGraceMs ?? 10_000;
    this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  }

  getMe(signal?: AbortSignal): Promise<{ id: number; username: string }> {
    return this.call("getMe", {}, signal);
  }

  getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<Update[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal, timeoutSec * 1000 + this.pollGraceMs);
  }

  async setMyCommands(commands: { command: string; description: string }[], signal?: AbortSignal): Promise<void> {
    await this.call("setMyCommands", { commands }, signal);
  }

  async sendMessage(chatId: number, text: string, o: { keyboard?: Keyboard; replyTo?: number } = {}): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (o.keyboard) body.reply_markup = { inline_keyboard: o.keyboard };
    if (o.replyTo !== undefined) body.reply_parameters = { message_id: o.replyTo, allow_sending_without_reply: true };
    const sent = await this.call<{ message_id: number }>("sendMessage", body);
    return sent.message_id;
  }

  async editMessageText(chatId: number, messageId: number, text: string, keyboard: Keyboard | null): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: keyboard ?? [] } });
  }

  async answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<void> {
    await this.call("answerCallbackQuery", text === undefined ? { callback_query_id: id } : { callback_query_id: id, text }, signal);
  }

  async downloadDocument(fileId: string, maxBytes: number): Promise<Buffer> {
    const tooLarge = () => new TelegramError("tooLarge", `The file is larger than ${maxBytes} bytes`);
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("notFound", "Telegram returned no file path");
    if (file.file_size !== undefined && file.file_size > maxBytes) throw tooLarge();
    return this.guarded(this.requestTimeoutMs, undefined, (guard) => this.readFile(`${this.base}/file/bot${this.token}/${file.file_path}`, maxBytes, guard));
  }

  private async readFile(url: string, maxBytes: number, guard: AbortSignal): Promise<Buffer> {
    const tooLarge = () => new TelegramError("tooLarge", `The file is larger than ${maxBytes} bytes`);
    const res = await this.send(url, { method: "GET", signal: guard });
    if (!res.ok) throw this.fromStatus(res.status, undefined);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const reader = res.body?.getReader();
      for (;;) {
        const part = await reader?.read();
        if (!part || part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          await reader?.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(Buffer.from(part.value));
      }
    } catch (err) {
      if (err instanceof TelegramError || isAbort(err, guard)) throw err;
      throw this.networkError(err);
    }
    return Buffer.concat(chunks);
  }

  private call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.requestTimeoutMs): Promise<T> {
    return this.guarded(timeoutMs, signal, async (guard) => {
      const res = await this.send(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: guard,
      });
      let reply: ApiReply<T> | undefined;
      try {
        reply = (await res.json()) as ApiReply<T>;
      } catch (err) {
        if (isAbort(err, guard)) throw err;
        // a good status with an unreadable body is a broken connection, not a bad request
        if (res.ok) throw this.networkError(err);
      }
      if (!res.ok || !reply?.ok) throw this.fromStatus(res.status, reply);
      return reply.result as T;
    });
  }

  /** Runs `fn` with a signal that fires on the caller's abort (rethrown as is) or after `timeoutMs` (a network error). */
  private async guarded<T>(timeoutMs: number, signal: AbortSignal | undefined, fn: (guard: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const onAbort = () => ctl.abort();
    if (signal?.aborted) ctl.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fn(ctl.signal);
    } catch (err) {
      if (timedOut && !signal?.aborted) throw new TelegramError("network", `Network error: no answer within ${Math.round(timeoutMs / 1000)} s`);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** fetch, turning a failure into a scrubbed network error (an abort passes through). */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(url, init);
    } catch (err) {
      if (isAbort(err, init.signal)) throw err;
      throw this.networkError(err, isConnectFailure(err));
    }
  }

  private networkError(err: unknown, unsent = false): TelegramError {
    const parts: string[] = [];
    let e: unknown = err;
    for (let depth = 0; e && depth < 4; depth++) {
      parts.push(e instanceof Error ? e.message : String(e));
      e = e instanceof Error ? e.cause : undefined;
    }
    return new TelegramError("network", scrub(`Network error: ${parts.join(": ")}`, this.token), undefined, unsent);
  }

  private fromStatus(status: number, reply: ApiReply<unknown> | undefined): TelegramError {
    const description = scrub(reply?.description ?? `HTTP ${status}`, this.token);
    const text = description.toLowerCase();
    if (status === 401) return new TelegramError("unauthorized", description);
    if (status === 409) return new TelegramError("conflict", description);
    if (status === 429) return new TelegramError("rateLimited", description, reply?.parameters?.retry_after);
    if (status === 400) {
      if (text.includes("message is not modified")) return new TelegramError("notModified", description);
      if (text.includes("message to edit not found") || text.includes("message can't be edited")) return new TelegramError("notFound", description);
      return new TelegramError("badRequest", description);
    }
    if (status === 404) return new TelegramError("notFound", description);
    if (status >= 500) return new TelegramError("server", description);
    return new TelegramError("badRequest", description);
  }
}

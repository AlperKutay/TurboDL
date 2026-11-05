import type { Keyboard, Update } from "./types";

export type TelegramErrorKind = "unauthorized" | "conflict" | "rateLimited" | "notModified" | "notFound" | "tooLarge" | "badRequest" | "server" | "network";

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfter?: number;
  constructor(kind: TelegramErrorKind, message: string, retryAfter?: number) {
    super(message);
    this.name = "TelegramError";
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

/** Replaces every occurrence of the token, so an error text can be logged or shown. */
export function scrub(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

export interface BotApiOptions {
  token: string;
  base?: string;
  fetch?: typeof fetch;
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

  constructor(o: BotApiOptions) {
    this.token = o.token;
    this.base = (o.base ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  }

  getMe(): Promise<{ id: number; username: string }> {
    return this.call("getMe", {});
  }

  getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<Update[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal);
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  async sendMessage(chatId: number, text: string, o: { keyboard?: Keyboard; replyTo?: number } = {}): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (o.keyboard) body.reply_markup = { inline_keyboard: o.keyboard };
    if (o.replyTo !== undefined) body.reply_parameters = { message_id: o.replyTo };
    const sent = await this.call<{ message_id: number }>("sendMessage", body);
    return sent.message_id;
  }

  async editMessageText(chatId: number, messageId: number, text: string, keyboard: Keyboard | null): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: keyboard ?? [] } });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", text === undefined ? { callback_query_id: id } : { callback_query_id: id, text });
  }

  async downloadDocument(fileId: string, maxBytes: number): Promise<Buffer> {
    const tooLarge = () => new TelegramError("tooLarge", `The file is larger than ${maxBytes} bytes`);
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("notFound", "Telegram returned no file path");
    if (file.file_size !== undefined && file.file_size > maxBytes) throw tooLarge();
    const res = await this.send(`${this.base}/file/bot${this.token}/${file.file_path}`, { method: "GET" });
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
      if (err instanceof TelegramError) throw err;
      throw this.networkError(err);
    }
    return Buffer.concat(chunks);
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.send(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    let reply: ApiReply<T> | undefined;
    try {
      reply = (await res.json()) as ApiReply<T>;
    } catch (err) {
      if (isAbort(err, signal)) throw err;
    }
    if (!res.ok || !reply?.ok) throw this.fromStatus(res.status, reply);
    return reply.result as T;
  }

  /** fetch, turning a failure into a scrubbed network error (an abort passes through). */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.doFetch(url, init);
    } catch (err) {
      if (isAbort(err, init.signal)) throw err;
      throw this.networkError(err);
    }
  }

  private networkError(err: unknown): TelegramError {
    const parts: string[] = [];
    let e: unknown = err;
    for (let depth = 0; e && depth < 4; depth++) {
      parts.push(e instanceof Error ? e.message : String(e));
      e = e instanceof Error ? e.cause : undefined;
    }
    return new TelegramError("network", scrub(`Network error: ${parts.join(": ")}`, this.token));
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

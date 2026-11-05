import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Keyboard, TgChat, TgUser, Update } from "../../src/main/telegram/types";

export interface FakeTelegram {
  /** base to pass as BotApiOptions.base */
  url: string;
  /** the one token it accepts; others get 401 */
  token: string;
  bot: { id: number; username: string };
  calls: { method: string; body: Record<string, unknown> }[];
  /** queued; a waiting getUpdates answers at once */
  push(update: Omit<Update, "update_id">): void;
  text(chatId: number, text: string, from?: Partial<TgUser>, chatType?: TgChat["type"]): void;
  press(chatId: number, messageId: number, data: string, fromId?: number): void;
  document(chatId: number, fileName: string, content: Buffer): void;
  /** current text of each bot message */
  sent(chatId?: number): { messageId: number; text: string; keyboard?: Keyboard; replyTo?: number }[];
  /** the next call of `method` answers with this status, e.g. 429 with retry_after */
  failNext(method: string, status: number, body?: Record<string, unknown>): void;
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

interface SentMessage {
  chatId: number;
  messageId: number;
  text: string;
  keyboard?: Keyboard;
  replyTo?: number;
}

const DESCRIPTIONS: Record<number, string> = { 401: "Unauthorized", 409: "Conflict: terminated by other getUpdates request", 429: "Too Many Requests: retry later", 400: "Bad Request" };

/** The token the fake accepts unless told another: shaped like one from @BotFather, which the app checks before saving. */
export const FAKE_TOKEN = "4242424242:AAE2eFakeTokenForTurboDL_tests-0123";

/** A local stand-in for the Telegram Bot API (127.0.0.1, free port) that accepts one token. */
export async function startFakeTelegram(o: { token?: string } = {}): Promise<FakeTelegram> {
  const token = o.token ?? FAKE_TOKEN;
  const bot = { id: 424242, username: "turbodl_test_bot" };
  const queue: Update[] = [];
  const messages: SentMessage[] = [];
  const files = new Map<string, { name: string; data: Buffer }>();
  const failures = new Map<string, { status: number; body?: Record<string, unknown> }[]>();
  const waiters = new Set<() => void>();
  const sockets = new Set<Socket>();
  let updateId = 100;
  let messageId = 1000;
  let fileCount = 0;
  let closing = false;
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const now = () => Math.floor(Date.now() / 1000);

  const fake: FakeTelegram = {
    url: "",
    token,
    bot,
    calls: [],
    push(update) {
      queue.push({ ...update, update_id: ++updateId });
      wake();
    },
    text(chatId, text, from = {}, chatType = "private") {
      fake.push({ message: { message_id: ++messageId, date: now(), chat: { id: chatId, type: chatType }, from: { id: chatId, ...from }, text } });
    },
    press(chatId, msgId, data, fromId = chatId) {
      const message = { message_id: msgId, date: now(), chat: { id: chatId, type: "private" as const }, from: bot };
      fake.push({ callback_query: { id: `cb${++updateId}`, from: { id: fromId }, message, data } });
    },
    document(chatId, fileName, content) {
      const fileId = `file${++fileCount}`;
      files.set(fileId, { name: fileName, data: content });
      fake.push({
        message: {
          message_id: ++messageId,
          date: now(),
          chat: { id: chatId, type: "private" },
          from: { id: chatId },
          document: { file_id: fileId, file_name: fileName, file_size: content.length },
        },
      });
    },
    sent(chatId) {
      return messages.filter((m) => chatId === undefined || m.chatId === chatId).map(({ messageId: id, text, keyboard, replyTo }) => ({ messageId: id, text, keyboard, replyTo }));
    },
    failNext(method, status, body) {
      const list = failures.get(method) ?? [];
      list.push({ status, body });
      failures.set(method, list);
    },
    waitFor(pred, ms = 5000) {
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          clearInterval(poll);
          waiters.delete(check);
        };
        const check = () => {
          if (!pred()) return;
          finish();
          resolve();
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("waitFor timed out"));
        }, ms);
        const poll = setInterval(check, 25);
        waiters.add(check);
        check();
      });
    },
    async close() {
      closing = true;
      wake();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const error = (res: http.ServerResponse, status: number, description: string) => reply(res, status, { ok: false, error_code: status, description });

  /** holds the request until an update is ready, `seconds` pass, the client leaves or the fake closes */
  const hold = (res: http.ServerResponse, seconds: number, ready: () => boolean) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(check);
        res.off("close", done);
        resolve();
      };
      const check = () => {
        if (ready() || closing) done();
      };
      const timer = setTimeout(done, seconds * 1000);
      waiters.add(check);
      res.on("close", done);
      check();
    });

  const handle = async (method: string, body: Record<string, unknown>, res: http.ServerResponse) => {
    const fail = failures.get(method)?.shift();
    if (fail) return reply(res, fail.status, fail.body ?? { ok: false, error_code: fail.status, description: DESCRIPTIONS[fail.status] ?? "Error" });
    switch (method) {
      case "getMe":
        return reply(res, 200, { ok: true, result: { ...bot, is_bot: true, first_name: "TurboDL test" } });
      case "setMyCommands":
      case "answerCallbackQuery":
        return reply(res, 200, { ok: true, result: true });
      case "getUpdates": {
        const offset = Number(body.offset ?? 0);
        // Telegram forgets updates below the offset
        if (offset > 0) queue.splice(0, queue.length, ...queue.filter((u) => u.update_id >= offset));
        await hold(res, Math.min(Number(body.timeout ?? 0), 1), () => queue.length > 0);
        if (res.destroyed || closing) return res.destroy();
        return reply(res, 200, { ok: true, result: queue.filter((u) => u.update_id >= offset) });
      }
      case "sendMessage": {
        const markup = body.reply_markup as { inline_keyboard?: Keyboard } | undefined;
        const replyTo = (body.reply_parameters as { message_id?: number } | undefined)?.message_id;
        const message: SentMessage = { chatId: Number(body.chat_id), messageId: ++messageId, text: String(body.text), keyboard: markup?.inline_keyboard, replyTo };
        messages.push(message);
        return reply(res, 200, { ok: true, result: { message_id: message.messageId, date: now(), chat: { id: message.chatId, type: "private" }, text: message.text } });
      }
      case "editMessageText": {
        const target = messages.find((m) => m.chatId === Number(body.chat_id) && m.messageId === Number(body.message_id));
        if (!target) return error(res, 400, "Bad Request: message to edit not found");
        const markup = body.reply_markup as { inline_keyboard?: Keyboard } | undefined;
        const keyboard = markup?.inline_keyboard?.length ? markup.inline_keyboard : undefined;
        if (target.text === body.text && JSON.stringify(target.keyboard) === JSON.stringify(keyboard)) return error(res, 400, "Bad Request: message is not modified");
        target.text = String(body.text);
        target.keyboard = keyboard;
        return reply(res, 200, { ok: true, result: true });
      }
      case "getFile": {
        const file = files.get(String(body.file_id));
        if (!file) return error(res, 400, "Bad Request: wrong file_id");
        return reply(res, 200, { ok: true, result: { file_id: String(body.file_id), file_size: file.data.length, file_path: `documents/${body.file_id}/${file.name}` } });
      }
      default:
        return error(res, 404, "Not Found");
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const filePrefix = `/file/bot${token}/documents/`;
      if (req.method === "GET" && url.pathname.startsWith(filePrefix)) {
        const file = files.get(decodeURIComponent(url.pathname.slice(filePrefix.length).split("/")[0]));
        if (!file) return error(res, 404, "Not Found");
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.data.length });
        return res.end(file.data);
      }
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      if (!match || req.method !== "POST") return error(res, 404, "Not Found");
      if (match[1] !== token) return error(res, 401, "Unauthorized");
      let body: Record<string, unknown> = {};
      try {
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        return error(res, 400, "Bad Request: invalid JSON");
      }
      fake.calls.push({ method: match[2], body });
      void handle(match[2], body, res);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

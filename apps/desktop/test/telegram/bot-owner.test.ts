import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIST_WAIT, DEFAULT_SAVE_OPTIONS, effectiveSaveOptions, parseProfileList, saveJobOptions } from "@turbodl/shared";
import { UNFINISHED } from "../../src/main/instagram/profile-lists";
import { JsonStore } from "../../src/main/store";
import { BotApi } from "../../src/main/telegram/bot-api";
import { TelegramBot, type BotApp } from "../../src/main/telegram/bot";
import { EMPTY_STATE, type BotStateFile } from "../../src/main/telegram/state";
import { EXPIRED, HELP, NO_LIST, NOTHING_RUNNING, SAVED_REFUSED, SEND_SOMETHING, jobFinalText, jobSummary, jobText, listText, statusText } from "../../src/main/telegram/texts";
import type { Keyboard } from "../../src/main/telegram/types";
import { listView, makeApp, type FakeApp } from "../fixtures/fake-bot-app";
import { startFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram";

const OWNER = 7;

let fake: FakeTelegram;
let dir: string;
let store: JsonStore<BotStateFile>;
let bots: TelegramBot[];
let logs: string[];
let clock: number;
/** the chat the bot is bound to */
let bound: number;

function makeBot(app: BotApp): TelegramBot {
  const bot = new TelegramBot({
    api: new BotApi({ token: fake.token, base: fake.url, requestTimeoutMs: 2000, pollGraceMs: 1000 }),
    app,
    chatId: () => bound,
    pairing: () => null,
    onPaired: () => undefined,
    onStatus: () => undefined,
    store,
    afterAppStart: false,
    // 10 s further at every read: the outbox's 1 s gap and 5 s edit throttle never hold a test up
    now: () => (clock += 10_000),
    wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
    log: (text) => logs.push(text),
    token: fake.token,
  });
  bots.push(bot);
  return bot;
}

async function startBot(h: FakeApp = makeApp()): Promise<{ h: FakeApp; bot: TelegramBot }> {
  const bot = makeBot(h.app);
  bot.start();
  await fake.waitFor(() => fake.calls.some((c) => c.method === "getUpdates"));
  return { h, bot };
}

const sent = () => fake.sent(OWNER);
const answers = () => fake.calls.filter((c) => c.method === "answerCallbackQuery");
const ticked = (keyboard?: Keyboard) => (keyboard ?? []).flat().filter((b) => b.text.startsWith("✓ ")).map((b) => b.text.slice(2));

function button(message: { keyboard?: Keyboard }, label: string): string {
  const found = (message.keyboard ?? []).flat().find((b) => b.text.replace(/^✓ /, "") === label);
  if (!found) throw new Error(`no ${label} button in ${JSON.stringify(message.keyboard)}`);
  return found.callback_data;
}

/** Presses a button and waits for the bot's answer to it; the answer's toast, if any. */
async function press(messageId: number, data: string): Promise<string | undefined> {
  const before = answers().length;
  fake.press(OWNER, messageId, data);
  await fake.waitFor(() => answers().length > before);
  return answers()[before].body.text as string | undefined;
}

function stateFile(): BotStateFile {
  try {
    return JSON.parse(readFileSync(path.join(dir, "telegram-state.json"), "utf8")) as BotStateFile;
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

beforeEach(async () => {
  fake = await startFakeTelegram();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-bot-owner-"));
  store = new JsonStore<BotStateFile>(path.join(dir, "telegram-state.json"), 0);
  bots = [];
  logs = [];
  clock = Date.now();
  bound = OWNER;
});

afterEach(async () => {
  for (const bot of bots) await bot.stop();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("profiles", () => {
  it("a username opens the prompt with the defaults", async () => {
    const h = makeApp();
    h.save = { posts: true, highlights: false, tagged: true, photos: true, videos: false };
    h.instagram = { signedIn: true, username: "me" };
    await startBot(h);
    fake.text(OWNER, "@NASA");
    await fake.waitFor(() => sent().length === 1);
    expect(sent()[0].text).toBe("@nasa — what should TurboDL save?\nSigned in as @me.");
    expect(ticked(sent()[0].keyboard)).toEqual(["Posts", "Tagged", "Photos"]);

    // signed out, Tagged starts off whatever the settings say
    h.instagram = { signedIn: false };
    fake.text(OWNER, "https://www.instagram.com/vercel/");
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[1].text).toBe("@vercel — what should TurboDL save?\nSigned out: Tagged needs a sign-in.");
    expect(ticked(sent()[1].keyboard)).toEqual(["Posts", "Photos"]);
    expect(h.created).toEqual([]);
  });

  it("Start runs the profile backup with the chosen options", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "nasa");
    await fake.waitFor(() => sent().length === 1);
    const prompt = sent()[0];
    expect(await press(prompt.messageId, button(prompt, "Highlights"))).toBeUndefined();
    expect(await press(prompt.messageId, button(prompt, "Videos"))).toBeUndefined();
    // each change shows on the prompt
    await fake.waitFor(() => ticked(sent()[0].keyboard).join() === "Posts,Photos");
    expect(await press(prompt.messageId, button(prompt, "Start"))).toBeUndefined();
    const chosen = { posts: true, highlights: false, tagged: false, photos: true, videos: false };
    expect(h.created).toEqual([{ url: "https://www.instagram.com/nasa/", options: saveJobOptions(chosen) }]);
    expect(h.created[0].options).toEqual({ videos: false });
  });

  it("the prompt message becomes the job's message and ends with a summary reply", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "nasa");
    await fake.waitFor(() => sent().length === 1);
    const id = sent()[0].messageId;
    await press(id, button(sent()[0], "Start"));
    const record = h.records.get("job1")!;
    const label = "@nasa profile backup";
    await fake.waitFor(() => sent()[0].text === jobText(record.view(), label));
    expect(sent()[0].text).toBe(`${label}\nQueued`);
    expect(sent()[0].keyboard).toEqual([[{ text: "Stop", callback_data: "s:job1" }]]);
    // followed while it runs
    await fake.waitFor(() => stateFile().jobs.length === 1);
    expect(stateFile().jobs).toEqual([{ jobId: "job1", chatId: OWNER, messageId: id, kind: "instagramProfile", label }]);

    record.start();
    record.progress({ done: 3, total: 10 });
    await fake.waitFor(() => sent()[0].text === `${label}\nRunning\n3/10`);
    record.file("C:/dl/nasa/a.jpg", true);
    record.file("C:/dl/nasa/b.jpg", true);
    record.file("C:/dl/nasa/c.jpg");
    record.end({ state: "done" });
    const final = record.view();
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[0]).toMatchObject({ messageId: id, text: jobFinalText(final, label, 2), keyboard: undefined });
    expect(sent()[1]).toMatchObject({ text: jobSummary(final, label, 2), replyTo: id });
    expect(sent()[1].text).toBe(`Done: ${label} — 3 files saved (2 already there).\nFolder: C:/dl/nasa`);
    await fake.waitFor(() => stateFile().jobs.length === 0);
    expect(record.followers).toBe(0);
  });
});

describe("links", () => {
  it("ten links make ten jobs and ten summaries", async () => {
    const { h } = await startBot();
    const urls = Array.from({ length: 10 }, (_, i) => `https://files.example.com/pack/part${i + 1}.zip`);
    const labels = urls.map((_, i) => `files.example.com part${i + 1}.zip`);
    const slowDown = { ok: false, error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } };
    fake.failNext("sendMessage", 429, slowDown);
    fake.text(OWNER, urls.join("\n"));
    await fake.waitFor(() => sent().length === 10);
    expect(h.created).toEqual(urls.map((url) => ({ url })));
    expect(sent().map((m) => m.text)).toEqual(labels.map((label) => `${label}\nQueued`));
    expect(sent().map((m) => m.keyboard)).toEqual(urls.map((_, i) => [[{ text: "Stop", callback_data: `s:job${i + 1}` }]]));
    await fake.waitFor(() => stateFile().jobs.length === 10);

    // all of them run and end at once: a burst of edits, final edits and summaries, with Telegram asking to slow down
    fake.failNext("editMessageText", 429, slowDown);
    fake.failNext("sendMessage", 429, slowDown);
    urls.forEach((_, i) => {
      const record = h.records.get(`job${i + 1}`)!;
      record.start();
      record.progress({ done: 0, bytes: 512, totalBytes: 1024, speed: 256 });
      record.file(`C:/dl/part${i + 1}.zip`);
      record.end({ state: "done" });
    });
    await fake.waitFor(() => sent().length === 20, 15_000);
    const messages = sent().slice(0, 10);
    const summaries = sent().slice(10);
    messages.forEach((m, i) => {
      expect(m).toMatchObject({ text: jobFinalText(h.records.get(`job${i + 1}`)!.view(), labels[i], 0), keyboard: undefined });
    });
    expect(summaries.map((s) => s.replyTo).sort()).toEqual(messages.map((m) => m.messageId).sort());
    for (const s of summaries) expect(s.text).toMatch(/^Done: files\.example\.com part\d+\.zip — 1 file saved\.\nFolder: C:\/dl$/);
    await fake.waitFor(() => stateFile().jobs.length === 0);
  });

  it("a saved link is refused and makes no job", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "https://www.instagram.com/me/saved/ https://www.instagram.com/me/saved/ https://example.com/a.zip");
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[0].text).toBe(SAVED_REFUSED);
    expect(sent()[1].text).toBe("example.com a.zip\nQueued");
    expect(h.created).toEqual([{ url: "https://example.com/a.zip" }]);

    fake.text(OWNER, "https://www.instagram.com/me/saved/");
    await fake.waitFor(() => sent().length === 3);
    expect(sent()[2].text).toBe(SAVED_REFUSED);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent()).toHaveLength(3);
    expect(h.created).toHaveLength(1);
  });

  it("a job that ended before the bot followed it still gets its summary", async () => {
    const { h } = await startBot();
    h.endAtOnce = true;
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => sent().length === 2);
    const final = h.records.get("job1")!.view();
    expect(final.state).toBe("done");
    expect(sent()[0]).toMatchObject({ text: jobFinalText(final, "example.com a.zip", 0), keyboard: undefined });
    expect(sent()[1]).toMatchObject({ text: "Done: example.com a.zip — 1 file saved.\nFolder: C:/dl", replyTo: sent()[0].messageId });
    await fake.waitFor(() => stateFile().offset > 0 && stateFile().jobs.length === 0);
  });

  it("a link that can't start says why and the others still start", async () => {
    const { h } = await startBot();
    const createJob = h.app.createJob;
    h.app.createJob = (request) => {
      if (request.url.includes("broken")) throw new Error("no runner for this");
      return createJob(request);
    };
    fake.text(OWNER, "https://example.com/broken.zip https://example.com/b.zip");
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[0].text).toBe("TurboDL couldn't start https://example.com/broken.zip: no runner for this");
    expect(sent()[1].text).toBe("example.com b.zip\nQueued");
  });
});

describe("lists", () => {
  it("a messy txt becomes the list the app would read", async () => {
    const { h } = await startBot();
    const content = "\uFEFF@Name\r\nhttps://www.instagram.com/vercel/\r\n\r\n  raycast  \r\n\r\nnot a profile!\r\n";
    fake.document(OWNER, "LIST.TXT", Buffer.from(content, "utf8"));
    await fake.waitFor(() => sent().length === 1);
    const parsed = parseProfileList(content);
    expect(parsed.usernames).toEqual(["name", "vercel", "raycast"]);
    expect(sent()[0].text).toBe("List: 3 profiles\n1 line wasn't a profile: not a profile!\nSigned out: Tagged needs a sign-in.\nWait between profiles: 2–5 min");
    await press(sent()[0].messageId, button(sent()[0], "Start"));
    expect(h.started).toEqual([{ name: "LIST", usernames: parsed.usernames, options: effectiveSaveOptions(DEFAULT_SAVE_OPTIONS, false), wait: DEFAULT_LIST_WAIT }]);

    fake.document(OWNER, "many.txt", Buffer.from(Array.from({ length: 1001 }, (_, i) => `user${i}`).join("\n")));
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[1].text).toBe("A list can hold at most 1,000 profiles.");

    const downloads = fake.calls.filter((c) => c.method === "getFile").length;
    fake.document(OWNER, "big.txt", Buffer.alloc(2 * 1024 * 1024, 0x61));
    await fake.waitFor(() => sent().length === 3);
    expect(sent()[2].text).toBe("This file is too large for a list of profiles (over 1 MB).");
    expect(fake.calls.filter((c) => c.method === "getFile")).toHaveLength(downloads);

    fake.document(OWNER, "photo.txt", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xd8]));
    await fake.waitFor(() => sent().length === 4);
    expect(sent()[3].text).toBe("The list has no profiles.");
    expect(h.started).toHaveLength(1);
  });

  it("a txt Telegram won't hand over is reported", async () => {
    await startBot();
    fake.failNext("getFile", 400);
    fake.document(OWNER, "list.txt", Buffer.from("nasa\n"));
    await fake.waitFor(() => sent().length === 1);
    expect(sent()[0].text).toBe("TurboDL couldn't get the file from Telegram; send it again.");
    expect(logs.join("\n")).not.toContain(fake.token);
  });

  it("several names open a list prompt", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "nasa vercel, raycast");
    await fake.waitFor(() => sent().length === 1);
    const prompt = sent()[0];
    expect(prompt.text).toBe("List: 3 profiles\nSigned out: Tagged needs a sign-in.\nWait between profiles: 2–5 min");
    await press(prompt.messageId, button(prompt, "Wait 2–5 min"));
    await fake.waitFor(() => sent()[0].text.endsWith("Wait between profiles: 1–3 min"));
    await press(prompt.messageId, button(prompt, "Start"));
    expect(h.started).toEqual([{ name: "Telegram list", usernames: ["nasa", "vercel", "raycast"], options: effectiveSaveOptions(DEFAULT_SAVE_OPTIONS, false), wait: { min: 1, max: 3 } }]);
    // the prompt message becomes the list message, the one the bot follows
    await fake.waitFor(() => sent()[0].text === listText(h.list!, 0));
    expect(sent()[0].keyboard).toEqual([[{ text: "Stop", callback_data: "sl" }]]);
    await fake.waitFor(() => stateFile().list !== null);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: prompt.messageId, active: true });

    // more names than a list holds get the app's refusal
    fake.text(OWNER, Array.from({ length: 1001 }, (_, i) => `user${i}`).join(" "));
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[1].text).toBe("A list can hold at most 1,000 profiles.");
  });

  it("a second list while one is there offers Show list", async () => {
    const h = makeApp();
    h.list = listView("stopped");
    await startBot(h);
    fake.text(OWNER, "raycast vercel");
    await fake.waitFor(() => sent().length === 1);
    const id = sent()[0].messageId;
    await press(id, button(sent()[0], "Start"));
    await fake.waitFor(() => sent()[0].text === UNFINISHED);
    expect(sent()[0].keyboard).toEqual([[{ text: "Show list", callback_data: "lv" }]]);
    expect(h.started).toHaveLength(1);

    expect(await press(id, "lv")).toBeUndefined();
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[1]).toMatchObject({ text: listText(h.list!, 0), keyboard: [[{ text: "Continue", callback_data: "lc" }, { text: "Close", callback_data: "lx" }]] });
    await fake.waitFor(() => stateFile().list !== null);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: sent()[1].messageId, active: false });

    // any other refusal is shown without buttons
    h.startRefusal = "Waits are whole minutes from 0 to 1440, the most at least the least.";
    fake.text(OWNER, "raycast vercel");
    await fake.waitFor(() => sent().length === 3);
    await press(sent()[2].messageId, button(sent()[2], "Start"));
    await fake.waitFor(() => sent()[2].text === h.startRefusal);
    expect(sent()[2].keyboard).toBeUndefined();
  });

  it("/list sends the list message, or says there is none", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "/list");
    await fake.waitFor(() => sent().length === 1);
    expect(sent()[0]).toMatchObject({ text: NO_LIST, keyboard: undefined });

    h.list = listView("running");
    fake.text(OWNER, "/list");
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[1]).toMatchObject({ text: listText(h.list, 0), keyboard: [[{ text: "Stop", callback_data: "sl" }]] });
    await fake.waitFor(() => stateFile().list !== null);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: sent()[1].messageId, active: true });
  });
});

describe("stop and status", () => {
  it("Stop on a job message cancels it", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => sent().length === 1);
    h.records.get("job1")!.start();
    const id = sent()[0].messageId;
    expect(await press(id, "s:job1")).toBeUndefined();
    expect(h.cancelled).toEqual(["job1"]);
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[0]).toMatchObject({ text: "example.com a.zip\nStopped.", keyboard: undefined });
    expect(sent()[1]).toMatchObject({ text: "Stopped: example.com a.zip", replyTo: id });
  });

  it("/stop lists running jobs, Stop all cancels them and the list", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "/stop");
    await fake.waitFor(() => sent().length === 1);
    expect(sent()[0]).toMatchObject({ text: NOTHING_RUNNING, keyboard: undefined });

    h.list = listView("waiting");
    fake.text(OWNER, "https://example.com/a.zip https://example.com/b.zip");
    await fake.waitFor(() => sent().length === 3);
    fake.text(OWNER, "/stop");
    await fake.waitFor(() => sent().length === 4);
    const menu = sent()[3];
    expect(menu.text).toBe("What should TurboDL stop?");
    expect(menu.keyboard).toEqual([
      [{ text: "Stop example.com b.zip", callback_data: "s:job2" }],
      [{ text: "Stop example.com a.zip", callback_data: "s:job1" }],
      [{ text: "Stop list", callback_data: "sl" }],
      [{ text: "Stop all", callback_data: "sa" }],
    ]);

    expect(await press(menu.messageId, "sa")).toBeUndefined();
    expect(h.cancelled.sort()).toEqual(["job1", "job2"]);
    await fake.waitFor(() => h.listCalls.includes("stop"));
    await fake.waitFor(() => sent().length === 6);
    expect(sent().slice(4).map((m) => m.text).sort()).toEqual(["Stopped: example.com a.zip", "Stopped: example.com b.zip"]);

    // nothing left to stop
    fake.text(OWNER, "/stop");
    await fake.waitFor(() => sent().length === 7);
    expect(sent()[6].text).toBe(NOTHING_RUNNING);
  });

  it("/status shows the sign-in and running jobs", async () => {
    const { h } = await startBot();
    h.instagram = { signedIn: true, username: "me" };
    fake.text(OWNER, "https://example.com/a.zip https://example.com/b.zip");
    await fake.waitFor(() => sent().length === 2);
    const a = h.records.get("job1")!;
    a.start();
    a.progress({ done: 0, bytes: 512, totalBytes: 1024, speed: 256 });
    h.records.get("job2")!.end({ state: "done" });
    h.list = listView("running");
    await fake.waitFor(() => sent().length === 3);
    fake.text(OWNER, "/status");
    await fake.waitFor(() => sent().length === 4);
    const status = sent()[3].text;
    expect(status).toBe(statusText({ version: "0.10.0", instagram: h.instagram, jobs: [{ label: "example.com a.zip", job: a.view() }], list: h.list }));
    expect(status).toContain("Instagram: signed in as @me");
    expect(status).toContain("example.com a.zip - running");
    expect(status).not.toContain("b.zip");
  });

  it("every press is answered", async () => {
    const { h } = await startBot();
    h.continueResult = { ok: false, error: "The list is running." };
    h.closeResult = { ok: false, error: "Stop the list first." };
    // a prompt from before a restart, a button the bot never made, a job that is gone
    expect(await press(1, "p:zzzz1:start")).toBe(EXPIRED);
    expect(await press(1, "x")).toBe(EXPIRED);
    expect(await press(1, "s:nope")).toBeUndefined();
    expect(await press(1, "sa")).toBeUndefined();
    expect(await press(1, "sl")).toBeUndefined();
    expect(await press(1, "lc")).toBe("The list is running.");
    expect(await press(1, "lx")).toBe("Stop the list first.");
    expect(await press(1, "lv")).toBe(NO_LIST);

    fake.text(OWNER, "nasa");
    await fake.waitFor(() => sent().length === 1);
    const prompt = sent()[0];
    expect(await press(prompt.messageId, button(prompt, "Tagged"))).toBe("Tagged needs a sign-in.");
    await press(prompt.messageId, button(prompt, "Posts"));
    await press(prompt.messageId, button(prompt, "Highlights"));
    expect(await press(prompt.messageId, button(prompt, "Start"))).toBe("Pick at least one of posts, highlights and tagged posts.");
    expect(await press(prompt.messageId, button(prompt, "Cancel"))).toBeUndefined();
    await fake.waitFor(() => sent()[0].text === "Cancelled.");
    expect(sent()[0].keyboard).toBeUndefined();
    expect(await press(prompt.messageId, button(prompt, "Start"))).toBe(EXPIRED);

    expect(answers()).toHaveLength(14);
    expect(new Set(answers().map((a) => a.body.callback_query_id)).size).toBe(14);
    expect(h.created).toEqual([]);
  });

  it("commands and what it can't read get the help", async () => {
    await startBot();
    fake.text(OWNER, "/help");
    fake.text(OWNER, "/start");
    fake.text(OWNER, "what is this?");
    fake.document(OWNER, "photo.jpg", Buffer.from([0xff, 0xd8]));
    await fake.waitFor(() => sent().length === 4);
    expect(sent().map((m) => m.text)).toEqual([HELP, HELP, HELP, SEND_SOMETHING]);
  });

  it("a job's news never goes to a chat that is no longer bound", async () => {
    const { h } = await startBot();
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => stateFile().jobs.length === 1);
    const before = fake.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").length;
    // the owner paired another chat while the job ran
    bound = 99;
    const record = h.records.get("job1")!;
    record.start();
    record.end({ state: "done" });
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")).toHaveLength(before);
    expect(sent()[0].text).toBe("example.com a.zip\nQueued");
  });

  it("stopping the bot stops following its jobs", async () => {
    const { h, bot } = await startBot();
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => stateFile().jobs.length === 1);
    const record = h.records.get("job1")!;
    expect(record.followers).toBe(1);
    await bot.stop();
    expect(record.followers).toBe(0);
    const calls = fake.calls.length;
    record.end({ state: "done" });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.length).toBe(calls);
    // its message stays in the state file for the next start
    expect(stateFile().jobs.map((j) => j.jobId)).toEqual(["job1"]);
    // nothing went to another chat
    expect(fake.sent()).toHaveLength(sent().length);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileListView } from "@turbodl/shared";
import { JsonStore } from "../../src/main/store";
import { BotApi } from "../../src/main/telegram/bot-api";
import { TelegramBot, type BotApp } from "../../src/main/telegram/bot";
import { EMPTY_STATE, type BotStateFile } from "../../src/main/telegram/state";
import { LIST_CLOSED, RESTARTED_LINK, RESTARTED_PROFILE, RESTARTED_UNSTARTED, jobRestartedText, jobSummary, jobText, listRestartedText, listText } from "../../src/main/telegram/texts";
import type { Keyboard } from "../../src/main/telegram/types";
import { listView, makeApp, type FakeApp } from "../fixtures/fake-bot-app";
import { startFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram";

const OWNER = 7;
const STOP_LIST: Keyboard = [[{ text: "Stop", callback_data: "sl" }]];
const CONTINUE_CLOSE: Keyboard = [[{ text: "Continue", callback_data: "lc" }, { text: "Close", callback_data: "lx" }]];

let fake: FakeTelegram;
let dir: string;
let store: JsonStore<BotStateFile>;
let bots: TelegramBot[];
let logs: string[];
let clock: number;
/** the chat the bot is bound to */
let bound: number | null;

const quickWait = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function makeBot(app: BotApp, afterAppStart = false, wait: (ms: number, signal: AbortSignal) => Promise<void> = quickWait): TelegramBot {
  const bot = new TelegramBot({
    api: new BotApi({ token: fake.token, base: fake.url, requestTimeoutMs: 2000, pollGraceMs: 1000 }),
    app,
    chatId: () => bound,
    pairing: () => null,
    onPaired: () => undefined,
    onStatus: () => undefined,
    store,
    afterAppStart,
    // 10 s further at every read: the outbox's 1 s gap and 5 s edit throttle never hold a test up
    now: () => (clock += 10_000),
    wait,
    log: (text) => logs.push(text),
    token: fake.token,
  });
  bots.push(bot);
  return bot;
}

const polls = () => fake.calls.filter((c) => c.method === "getUpdates").length;

/** Starts a bot and waits for its first poll: whatever it recovered is queued by then. */
async function startBot(h: FakeApp, afterAppStart = false): Promise<TelegramBot> {
  const before = polls();
  const bot = makeBot(h.app, afterAppStart);
  bot.start();
  await fake.waitFor(() => polls() > before);
  return bot;
}

const sent = () => fake.sent(OWNER);
const calls = (method: string) => fake.calls.filter((c) => c.method === method).length;
const settle = () => new Promise((r) => setTimeout(r, 200));
/** The edits asked of one message, from the `from`th call on. */
const editsOf = (messageId: number, from = 0) => fake.calls.slice(from).filter((c) => c.method === "editMessageText" && c.body.message_id === messageId).map((c) => c.body);

function stateFile(): BotStateFile {
  try {
    return JSON.parse(readFileSync(path.join(dir, "telegram-state.json"), "utf8")) as BotStateFile;
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

/** A list with its first `done` rows backed up. */
function listWith(state: ProfileListView["state"], done: number): ProfileListView {
  const list = listView(state, ["nasa", "vercel", "raycast"]);
  list.rows.forEach((row, i) => (row.state = i < done ? "done" : "waiting"));
  list.index = done;
  return list;
}

/** `/list` makes the list message the one the bot follows. */
async function showList(h: FakeApp, list: ProfileListView): Promise<number> {
  h.list = list;
  const count = sent().length;
  fake.text(OWNER, "/list");
  await fake.waitFor(() => sent().length === count + 1);
  const id = sent()[count].messageId;
  await fake.waitFor(() => stateFile().list?.messageId === id);
  return id;
}

/** Sends text that opens a prompt and presses its Start; the prompt's message id. */
async function startPrompt(text: string): Promise<number> {
  const count = sent().length;
  fake.text(OWNER, text);
  await fake.waitFor(() => sent().length === count + 1);
  const prompt = sent()[count];
  const start = (prompt.keyboard ?? []).flat().find((b) => b.text === "Start")!;
  fake.press(OWNER, prompt.messageId, start.callback_data);
  return prompt.messageId;
}

/** A profile backup started from Telegram: the prompt message becomes the job's message. */
async function startProfile(h: FakeApp, name: string): Promise<number> {
  const id = await startPrompt(name);
  await fake.waitFor(() => h.created.length > 0 && stateFile().jobs.some((j) => j.messageId === id));
  return id;
}

beforeEach(async () => {
  fake = await startFakeTelegram();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-bot-recovery-"));
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

describe("following the list", () => {
  it("list changes edit the list message", async () => {
    const h = makeApp();
    const bot = await startBot(h);
    const id = await showList(h, listWith("running", 0));
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: true });

    h.list = listWith("waiting", 1);
    bot.listChanged(h.list);
    await fake.waitFor(() => sent()[0].text === listText(h.list!, 0));
    expect(sent()[0].keyboard).toEqual(STOP_LIST);
    expect(sent()[0].text).toContain("1/3 profiles");

    // stopped by the owner in the app: the buttons change and the state file says it no longer goes on
    h.list = listWith("stopped", 1);
    bot.listChanged(h.list);
    await fake.waitFor(() => sent()[0].text === listText(h.list!, 0));
    expect(sent()[0].keyboard).toEqual(CONTINUE_CLOSE);
    await fake.waitFor(() => stateFile().list?.active === false);

    h.list = listWith("slowedDown", 1);
    bot.listChanged(h.list);
    await fake.waitFor(() => sent()[0].text === listText(h.list!, 0));
    await fake.waitFor(() => stateFile().list?.active === true);

    h.list = listWith("finished", 3);
    bot.listChanged(h.list);
    await fake.waitFor(() => sent()[0].text === listText(h.list!, 0));
    expect(sent()[0].keyboard).toEqual([[{ text: "Close", callback_data: "lx" }]]);
    await fake.waitFor(() => stateFile().list?.active === false);
    // every change went to the one list message
    expect(sent()).toHaveLength(1);
  });

  it("the list's active flag is on disk as soon as it changes", async () => {
    // a debounce that never fires in the test: only an explicit flush writes the file
    store = new JsonStore<BotStateFile>(path.join(dir, "telegram-state.json"), 60_000);
    const h = makeApp();
    const bot = await startBot(h);
    h.list = listWith("running", 0);
    fake.text(OWNER, "/list");
    await fake.waitFor(() => sent().length === 1);
    const id = sent()[0].messageId;
    // the bot follows the message once its id comes back; that alone waits for the debounce
    await settle();
    expect(stateFile().list).toBeNull();

    h.list = listWith("stopped", 0);
    bot.listChanged(h.list);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: false });
    h.list = listWith("running", 0);
    bot.listChanged(h.list);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: true });
  });

  it("list changes wait until the bot has recovered", async () => {
    const h = makeApp();
    const first = await startBot(h);
    const id = await showList(h, listWith("running", 0));
    await first.stop();

    // the next bot can't reach Telegram at first, and waits before it tries again
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const wait = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        void held.then(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    fake.failNext("getMe", 502);
    const gets = calls("getMe");
    const bot = makeBot(h.app, false, wait);
    bot.start();
    await fake.waitFor(() => calls("getMe") === gets + 1);
    const from = fake.calls.length;
    h.list = listWith("stopped", 1);
    bot.listChanged(h.list);
    await settle();
    expect(editsOf(id, from)).toEqual([]);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: true });

    // once it is through, the message catches up with the list as it is now
    release();
    await fake.waitFor(() => sent()[0].text === listText(h.list!, 0));
    expect(sent()[0].keyboard).toEqual(CONTINUE_CLOSE);
    expect(editsOf(id, from)).toHaveLength(1);
    await fake.waitFor(() => stateFile().list?.active === false);
    // the same app run: no restart notice
    expect(sent()).toHaveLength(1);
  });

  it("a closed list says so and is forgotten", async () => {
    const h = makeApp();
    const bot = await startBot(h);
    const id = await showList(h, listWith("finished", 3));
    h.list = null;
    bot.listChanged(null);
    await fake.waitFor(() => sent()[0].text === LIST_CLOSED);
    expect(LIST_CLOSED).toBe("The list was closed.");
    expect(sent()[0]).toMatchObject({ messageId: id, keyboard: undefined });
    await fake.waitFor(() => stateFile().list === null);

    // a list the bot doesn't follow changes nothing in the chat
    const edits = calls("editMessageText");
    bot.listChanged(listWith("running", 0));
    await settle();
    expect(calls("editMessageText")).toBe(edits);
    expect(sent()).toHaveLength(1);
  });

  it("a notice is sent as a new message", async () => {
    const h = makeApp();
    const bot = await startBot(h);
    await showList(h, listWith("running", 0));
    bot.listNotice("Profile list finished: 3 backed up, 0 skipped.");
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[1]).toEqual({ messageId: sent()[1].messageId, text: "Profile list finished: 3 backed up, 0 skipped.", keyboard: undefined, replyTo: undefined });

    // no bound chat: nobody to tell
    bound = null;
    const sends = calls("sendMessage");
    bot.listNotice("Profile list stopped: Instagram signed TurboDL out.");
    await settle();
    expect(calls("sendMessage")).toBe(sends);
  });

  it.each([
    ["before startList answers", true],
    ["only after startList answered", false],
  ])("a new list in place of a finished one leaves the finished list's words without its Close (app tells %s)", async (_when, early) => {
    const h = makeApp();
    const bot = await startBot(h);
    // the app tells the bot of every change, of a list started from Telegram too
    const startList = h.app.startList;
    h.app.startList = async (request) => {
      const result = await startList(request);
      if (early) bot.listChanged(h.list);
      else setTimeout(() => bot.listChanged(h.list), 50);
      return result;
    };
    const finished = listWith("finished", 3);

    // started in the app: the finished list's message is no longer followed, and its Close would close the new list
    const first = await showList(h, finished);
    h.list = listWith("running", 0);
    bot.listChanged(h.list);
    await fake.waitFor(() => stateFile().list === null);
    await fake.waitFor(() => sent()[0].keyboard === undefined);
    expect(sent()[0]).toMatchObject({ messageId: first, text: listText(finished, 0), keyboard: undefined });

    // started from Telegram: the prompt becomes the new list's message
    const second = await showList(h, finished);
    const prompt = await startPrompt("raycast vercel");
    await fake.waitFor(() => stateFile().list?.messageId === prompt);
    await fake.waitFor(() => sent()[2].text === listText(h.list!, 0));
    expect(sent()[2].keyboard).toEqual(STOP_LIST);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: prompt, active: true });
    await fake.waitFor(() => sent()[1].keyboard === undefined);
    expect(sent()[1]).toMatchObject({ messageId: second, text: listText(finished, 0), keyboard: undefined });
    await settle();
    // the new list's message still has its Stop, and nothing else was sent
    expect(sent()[2].keyboard).toEqual(STOP_LIST);
    expect(sent()).toHaveLength(3);
  });

  it("/list again moves the buttons to the new list message", async () => {
    const h = makeApp();
    const bot = await startBot(h);
    const first = await showList(h, listWith("running", 1));
    expect(sent()[0].keyboard).toEqual(STOP_LIST);
    const second = await showList(h, listWith("running", 1));
    await fake.waitFor(() => sent()[0].keyboard === undefined);
    // the old message keeps the list's words, without a Stop that would act on whatever list comes next
    expect(sent()[0]).toMatchObject({ messageId: first, text: listText(h.list!, 0), keyboard: undefined });
    expect(sent()[1]).toMatchObject({ messageId: second, keyboard: STOP_LIST });
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: second, active: true });

    // only the new message follows the list from now on
    const from = fake.calls.length;
    h.list = listWith("stopped", 2);
    bot.listChanged(h.list);
    await fake.waitFor(() => sent()[1].text === listText(h.list!, 0));
    expect(sent()[1].keyboard).toEqual(CONTINUE_CLOSE);
    await settle();
    expect(editsOf(first, from)).toEqual([]);
    expect(sent()).toHaveLength(2);
  });

  it("a list change after the bot stopped keeps the list active for the restart notice", async () => {
    const h = makeApp();
    const bot = await startBot(h);
    await showList(h, listWith("running", 1));
    await bot.stop();
    // the app's quit stops the list after the bot
    bot.listChanged(listWith("stopped", 1));
    bot.listNotice("Profile list stopped.");
    await settle();
    expect(stateFile().list?.active).toBe(true);
    expect(sent()).toHaveLength(1);
  });
});

describe("after a restart", () => {
  it("after a restart a profile job says send it again", async () => {
    const before = makeApp();
    const first = await startBot(before);
    const id = await startProfile(before, "nasa");
    await fake.waitFor(() => sent()[0].text === "@nasa profile backup\nQueued");
    await first.stop();

    // a new app run: the job is gone; Telegram is down at first
    fake.failNext("getMe", 502);
    await startBot(makeApp(), true);
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[0]).toEqual({ messageId: id, text: jobRestartedText("@nasa profile backup"), keyboard: undefined, replyTo: undefined });
    expect(sent()[0].text).toBe("@nasa profile backup\nTurboDL restarted.");
    expect(sent()[1]).toMatchObject({ text: RESTARTED_PROFILE, keyboard: undefined, replyTo: id });
    expect(RESTARTED_PROFILE).toBe("TurboDL restarted before this finished. Send it again; it skips what it already saved.");
    await fake.waitFor(() => stateFile().jobs.length === 0);
    // once, for all the retries of getMe
    await settle();
    expect(calls("getMe")).toBe(3);
    expect(sent()).toHaveLength(2);
  });

  it("after a restart a link job says it goes on and never send it again", async () => {
    const before = makeApp();
    const first = await startBot(before);
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => stateFile().jobs.length === 1);
    const record = before.records.get("job1")!;
    record.start();
    record.progress({ done: 0, bytes: 512, totalBytes: 1024, speed: 256 });
    await fake.waitFor(() => sent()[0].text.startsWith("example.com a.zip\nRunning"));
    await first.stop();
    const id = sent()[0].messageId;

    await startBot(makeApp(), true);
    await fake.waitFor(() => sent().length === 2);
    expect(sent()[0]).toMatchObject({ messageId: id, text: "example.com a.zip\nTurboDL restarted.", keyboard: undefined });
    expect(sent()[1]).toMatchObject({ text: RESTARTED_LINK, keyboard: undefined, replyTo: id });
    for (const m of sent()) expect(m.text).not.toMatch(/send it again/i);
    await fake.waitFor(() => stateFile().jobs.length === 0);
  });

  it("after a restart a link job that never got under way says send it again", async () => {
    const before = makeApp();
    const first = await startBot(before);
    fake.text(OWNER, "https://example.com/a.zip https://example.com/b.zip");
    await fake.waitFor(() => stateFile().jobs.length === 2);
    // a resolves, b is still queued: neither has a file or any progress, so nothing of them is in the app's list
    before.records.get("job1")!.start();
    before.records.get("job1")!.progress({ done: 0, note: "Reading the page" });
    await fake.waitFor(() => sent()[0].text.startsWith("example.com a.zip\nRunning"));
    await first.stop();
    expect(stateFile().jobs.map((j) => j.started)).toEqual([undefined, undefined]);
    const [idA, idB] = [sent()[0].messageId, sent()[1].messageId];

    await startBot(makeApp(), true);
    await fake.waitFor(() => sent().length === 4);
    expect(sent()[0]).toMatchObject({ messageId: idA, text: "example.com a.zip\nTurboDL restarted.", keyboard: undefined });
    expect(sent()[1]).toMatchObject({ messageId: idB, text: "example.com b.zip\nTurboDL restarted.", keyboard: undefined });
    expect(sent().slice(2)).toEqual([
      expect.objectContaining({ text: RESTARTED_UNSTARTED, keyboard: undefined, replyTo: idA }),
      expect.objectContaining({ text: RESTARTED_UNSTARTED, keyboard: undefined, replyTo: idB }),
    ]);
    expect(RESTARTED_UNSTARTED).toBe("TurboDL restarted before this started. Send it again.");
    await fake.waitFor(() => stateFile().jobs.length === 0);
  });

  it("a job's first file or progress is on disk at once", async () => {
    // a debounce that never fires in the test: only an explicit flush writes the file
    store = new JsonStore<BotStateFile>(path.join(dir, "telegram-state.json"), 60_000);
    const h = makeApp();
    await startBot(h);
    fake.text(OWNER, "https://example.com/a.zip https://example.com/b.zip https://example.com/c.zip");
    await fake.waitFor(() => sent().length === 3);
    await settle();
    const [a, b, c] = ["job1", "job2", "job3"].map((id) => h.records.get(id)!);
    // running, and progress without anything done yet, isn't under way
    a.start();
    a.progress({ done: 0, bytes: 0 });
    await settle();
    expect(stateFile().jobs.filter((j) => j.started)).toEqual([]);

    a.progress({ done: 0, bytes: 2048, totalBytes: 4096 });
    expect(stateFile().jobs.filter((j) => j.started).map((j) => j.jobId)).toEqual(["job1"]);
    b.start();
    b.progress({ done: 1, total: 3 });
    expect(stateFile().jobs.filter((j) => j.started).map((j) => j.jobId)).toEqual(["job1", "job2"]);
    c.start();
    c.file("C:/dl/c.zip");
    expect(stateFile().jobs.filter((j) => j.started).map((j) => j.jobId)).toEqual(["job1", "job2", "job3"]);
  });

  it("after a restart an active list that came back stopped gets Continue and Close", async () => {
    const before = makeApp();
    const first = await startBot(before);
    const id = await showList(before, listWith("waiting", 1));
    await first.stop();
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: true });

    // the app turns the list it was running into a stopped one on start
    const after = makeApp();
    after.list = listWith("stopped", 1);
    const bot = await startBot(after, true);
    await fake.waitFor(() => sent().length === 2 && sent()[0].text === listText(after.list!, 0));
    expect(sent()[0]).toMatchObject({ messageId: id, keyboard: CONTINUE_CLOSE });
    expect(sent()[1]).toMatchObject({ text: listRestartedText(after.list), keyboard: CONTINUE_CLOSE, replyTo: id });
    expect(sent()[1].text).toBe("TurboDL restarted; the list stopped at 1/3.");
    await fake.waitFor(() => stateFile().list?.active === false);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: false });

    // the message still follows the list
    after.list = listWith("running", 1);
    bot.listChanged(after.list);
    await fake.waitFor(() => sent()[0].text === listText(after.list!, 0));
    expect(sent()[0].keyboard).toEqual(STOP_LIST);
    expect(sent()).toHaveLength(2);
  });

  it("a list stopped by the owner before the restart gets no notice", async () => {
    const before = makeApp();
    const first = await startBot(before);
    const id = await showList(before, listWith("running", 1));
    before.list = listWith("stopped", 1);
    first.listChanged(before.list);
    await fake.waitFor(() => stateFile().list?.active === false);
    await first.stop();
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: false });

    const after = makeApp();
    after.list = listWith("stopped", 1);
    const edits = calls("editMessageText");
    const sends = calls("sendMessage");
    await startBot(after, true);
    // re-attached: the message is edited to what the app shows (unchanged here)
    await fake.waitFor(() => calls("editMessageText") > edits);
    await settle();
    expect(calls("sendMessage")).toBe(sends);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ text: listText(after.list, 0), keyboard: CONTINUE_CLOSE });
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: id, active: false });
  });

  it.each([
    ["after a restart", true],
    // the owner closed the list in the app's window while the bot was off
    ["inside one app run", false],
  ])("a list the app no longer has says it was closed and is forgotten %s", async (_when, afterAppStart) => {
    const before = makeApp();
    const first = await startBot(before);
    const id = await showList(before, listWith("finished", 3));
    await first.stop();

    const app = afterAppStart ? makeApp() : before;
    app.list = null;
    const sends = calls("sendMessage");
    const from = fake.calls.length;
    await startBot(app, afterAppStart);
    await fake.waitFor(() => sent()[0].text === LIST_CLOSED);
    await fake.waitFor(() => stateFile().list === null);
    await settle();
    expect(editsOf(id, from)).toEqual([{ chat_id: OWNER, message_id: id, text: LIST_CLOSED, reply_markup: { inline_keyboard: [] } }]);
    expect(sent()[0]).toMatchObject({ messageId: id, keyboard: undefined });
    expect(calls("sendMessage")).toBe(sends);
    expect(sent()).toHaveLength(1);
  });

  it.each([
    ["after a restart", true],
    ["inside one app run", false],
  ])("a job that ended before its summary went out only loses its Stop button %s", async (_when, afterAppStart) => {
    const before = makeApp();
    const first = await startBot(before);
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => stateFile().jobs.length === 1);
    const id = sent()[0].messageId;
    const record = before.records.get("job1")!;
    record.start();
    record.file("C:/dl/a.zip");
    record.end({ state: "done" });
    // the bot stops before its final edit and summary go out
    await first.stop();
    expect(stateFile().jobs).toEqual([{ jobId: "job1", chatId: OWNER, messageId: id, kind: "file", label: "example.com a.zip", started: true, ended: true }]);
    expect(sent()).toEqual([{ messageId: id, text: "example.com a.zip\nQueued", keyboard: [[{ text: "Stop", callback_data: "s:job1" }]], replyTo: undefined }]);

    const sends = calls("sendMessage");
    const from = fake.calls.length;
    await startBot(afterAppStart ? makeApp() : before, afterAppStart);
    await fake.waitFor(() => stateFile().jobs.length === 0);
    await fake.waitFor(() => editsOf(id, from).length === 1);
    await settle();
    // its message is left without a live Stop button
    expect(editsOf(id, from)).toEqual([{ chat_id: OWNER, message_id: id, text: jobRestartedText("example.com a.zip"), reply_markup: { inline_keyboard: [] } }]);
    expect(sent()[0]).toMatchObject({ messageId: id, keyboard: undefined });
    // neither "restarted before this finished" nor a second summary
    expect(calls("sendMessage")).toBe(sends);
  });

  it("a bot restart inside one app run follows its jobs again and sends no restart notice", async () => {
    const h = makeApp();
    const first = await startBot(h);
    fake.text(OWNER, "https://example.com/a.zip https://example.com/b.zip https://example.com/c.zip");
    await fake.waitFor(() => stateFile().jobs.length === 3);
    const [a, b] = [h.records.get("job1")!, h.records.get("job2")!];
    const listId = await showList(h, listWith("running", 1));
    await first.stop();
    const [idA, idB] = [sent()[0].messageId, sent()[1].messageId];

    // while the bot was off: a ran on, b ended, c left the app's registry
    a.start();
    a.progress({ done: 1, total: 4 });
    b.start();
    b.file("C:/dl/b.zip");
    b.end({ state: "done" });
    const job = h.app.job;
    h.app.job = (id) => (id === "job3" ? undefined : job(id));

    await startBot(h, false);
    // a is followed again: its message shows where it is now, with its Stop button
    await fake.waitFor(() => sent()[0].text === jobText(a.view(), "example.com a.zip"));
    expect(sent()[0].keyboard).toEqual([[{ text: "Stop", callback_data: "s:job1" }]]);
    // b ended: its summary comes now, as for any job the bot follows
    await fake.waitFor(() => sent().length === 5);
    expect(sent()[4]).toMatchObject({ text: jobSummary(b.view(), "example.com b.zip", 0), replyTo: idB });
    // the list is followed again, without a notice
    expect(sent()[3]).toMatchObject({ messageId: listId, text: listText(h.list!, 0), keyboard: STOP_LIST });
    await fake.waitFor(() => stateFile().jobs.length === 1);
    // a made progress while the bot was off: followed again, it counts as under way
    expect(stateFile().jobs).toEqual([{ jobId: "job1", chatId: OWNER, messageId: idA, kind: "file", label: "example.com a.zip", started: true }]);
    expect(stateFile().list).toEqual({ chatId: OWNER, messageId: listId, active: true });

    a.progress({ done: 3, total: 4 });
    await fake.waitFor(() => sent()[0].text === "example.com a.zip\nRunning\n3/4");
    expect(a.followers).toBe(1);
    expect(sent().map((m) => m.text).join("\n")).not.toContain("restarted");
    // b's summary came once
    await settle();
    expect(sent()).toHaveLength(5);
  });

  it("recovery never writes to a chat that is no longer bound", async () => {
    const before = makeApp();
    const first = await startBot(before);
    fake.text(OWNER, "https://example.com/a.zip");
    await fake.waitFor(() => stateFile().jobs.length === 1);
    await showList(before, listWith("running", 1));
    await first.stop();

    // the owner paired another chat before the app came back
    bound = 99;
    const after = makeApp();
    after.list = listWith("stopped", 1);
    const writes = calls("sendMessage") + calls("editMessageText");
    await startBot(after, true);
    await fake.waitFor(() => stateFile().jobs.length === 0 && stateFile().list === null);
    await settle();
    expect(calls("sendMessage") + calls("editMessageText")).toBe(writes);
  });

  it("a state from another bot recovers nothing", async () => {
    store.save({ botId: 1, offset: 0, jobs: [{ jobId: "gone", chatId: OWNER, messageId: 5, kind: "instagramProfile", label: "@nasa profile backup" }], list: { chatId: OWNER, messageId: 6, active: true } });
    store.flush();
    const after = makeApp();
    after.list = listWith("stopped", 1);
    await startBot(after, true);
    await settle();
    expect(calls("sendMessage") + calls("editMessageText")).toBe(0);
    expect(stateFile()).toEqual({ ...EMPTY_STATE, botId: fake.bot.id });
  });
});

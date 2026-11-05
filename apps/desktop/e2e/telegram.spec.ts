import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { TelegramStatus } from "@turbodl/shared";
import { startFakeTelegram, type FakeTelegram } from "../test/fixtures/fake-telegram";
import { startTestServer, type TestServer } from "../test/fixtures/test-server";
import { launchApp, type LaunchedApp } from "./helpers";

/**
 * The real app against a stand-in for the Telegram Bot API (TURBODL_TELEGRAM_API, honoured only with an isolated
 * profile) and the demo Instagram (TURBODL_INSTAGRAM_DEMO_BASE, signed in): the owner's chat is 42.
 */

const electronExe = createRequire(__filename)("electron") as string;
const CLI = path.join(__dirname, "..", "out", "cli", "turbodl.cjs");
/** shaped like a token from @BotFather, which the app checks before saving it */
const TOKEN = "4242424242:AAE2eFakeTokenForTurboDL_tests-0123";
const OWNER = 42;
const STRANGER = 99;
const HELP_START = "Send TurboDL one of these:";

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

const cliEnv = (userData: string) => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1", TURBODL_USER_DATA: userData });

/** Runs `turbodl <args>` from the built bundle against the app's temp profile; `input` is piped on stdin. */
function turbodl(userData: string, args: string[], input = ""): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(electronExe, [CLI, ...args], { env: cliEnv(userData), windowsHide: true, timeout: 90_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end(input);
  });
}

async function telegramStatus(userData: string): Promise<TelegramStatus> {
  const r = await turbodl(userData, ["telegram", "status", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as TelegramStatus;
}

function apiPort(userData: string): number | null {
  try {
    return (JSON.parse(readFileSync(path.join(userData, "api.json"), "utf8")) as { port: number | null }).port;
  } catch {
    return null;
  }
}

/** The command finds the app through api.json; a profile used before still has the last run's, so wait for this run's port. */
async function appReady(l: LaunchedApp): Promise<void> {
  await l.app.firstWindow();
  await expect.poll(() => apiPort(l.userData), { timeout: 15_000 }).toBe(l.port);
}

type Sent = ReturnType<FakeTelegram["sent"]>[number];

const buttons = (m: Sent | undefined) => (m?.keyboard ?? []).flat().map((b) => b.text);
const callbackData = (m: Sent, text: string) => {
  const data = (m.keyboard ?? []).flat().find((b) => b.text === text)?.callback_data;
  expect(data, `a ${text} button on "${m.text}"`).toBeTruthy();
  return data!;
};
const callsTo = (fake: FakeTelegram, method: string, chatId: number) => fake.calls.filter((c) => c.method === method && Number(c.body.chat_id) === chatId);

/** The bot's message to the owner whose text matches, once it is there. */
async function message(fake: FakeTelegram, match: (m: Sent) => boolean, timeout = 15_000): Promise<Sent> {
  await expect.poll(() => fake.sent(OWNER).some(match), { timeout }).toBe(true);
  return fake.sent(OWNER).find(match)!;
}

interface Ctx extends LaunchedApp {
  fake: FakeTelegram;
  server: TestServer;
}

async function withBot(settings: Record<string, unknown>, body: (ctx: Ctx) => Promise<void>): Promise<void> {
  const fake = await startFakeTelegram({ token: TOKEN });
  const server = await startTestServer();
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(3000), contentType: "image/png" }));
  const launched = await launchApp(settings, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, ""), TURBODL_TELEGRAM_API: fake.url });
  try {
    await appReady(launched);
    await body({ ...launched, fake, server });
  } finally {
    await launched.app.close().catch(() => undefined);
    await fake.close();
    await server.close();
    rmSync(launched.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

/** The bot already on and bound to the owner's chat: saving the token starts it, and the command waits until it is connected. */
const BOUND = { telegram: { enabled: true, chatId: OWNER } };

async function saveToken(userData: string): Promise<void> {
  const r = await turbodl(userData, ["telegram", "token"], `${TOKEN}\n`);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("Bot: @turbodl_test_bot");
  expect(r.stdout).toContain("State: connected");
  expect(r.stdout + r.stderr).not.toContain(TOKEN);
}

test.skip(process.platform !== "win32", "the app is driven on Windows, as the other e2e specs");

test("pairs from the command line and backs up a profile from Telegram", async () => {
  test.setTimeout(180_000);
  await withBot({}, async ({ fake, userData, baseDir }) => {
    // a fresh profile: the bot is off, so the token is only saved
    const saved = await turbodl(userData, ["telegram", "token"], `${TOKEN}\n`);
    expect(saved.stdout).toContain("State: off");
    expect(saved.stderr).toContain("Token saved; the bot is off.");
    expect(saved.stdout + saved.stderr).not.toContain(TOKEN);
    expect(await telegramStatus(userData)).toMatchObject({ state: "off", tokenSet: true, chatId: null, enabled: false });

    // pairing runs the bot until the code comes back from a private chat
    const pairing = spawn(electronExe, [CLI, "telegram", "pair"], { env: cliEnv(userData), windowsHide: true });
    try {
      pairing.stdin.end();
      let stdout = "";
      let stderr = "";
      pairing.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      pairing.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      const exited = new Promise<number | null>((resolve) => pairing.on("close", resolve));
      await expect.poll(() => /\/start (\d{6})/.exec(stdout)?.[1] ?? null, { timeout: 15_000 }).not.toBeNull();
      const code = /\/start (\d{6})/.exec(stdout)![1];
      fake.text(OWNER, `/start ${code}`);
      expect(await exited, stderr).toBe(0);
      expect(stderr).toContain(`Paired with chat ${OWNER}.`);
    } finally {
      if (pairing.exitCode === null) pairing.kill();
    }
    const welcome = await message(fake, (m) => m.text.startsWith("This chat now controls TurboDL."));
    expect(welcome.text).toContain(HELP_START);
    // pairing turned the bot on
    expect(await telegramStatus(userData)).toMatchObject({ state: "ok", bot: "turbodl_test_bot", tokenSet: true, chatId: OWNER, enabled: true });

    fake.text(OWNER, "demo.person");
    const prompt = await message(fake, (m) => m.text.startsWith("@demo.person — what should TurboDL save?"));
    // the app's defaults, signed in: everything on
    expect(buttons(prompt)).toEqual(["✓ Posts", "✓ Highlights", "✓ Tagged", "✓ Photos", "✓ Videos", "Start", "Cancel"]);
    fake.press(OWNER, prompt.messageId, callbackData(prompt, "Start"));

    // a summary as a reply to the prompt, which became the job's message
    const summary = await message(fake, (m) => m.replyTo === prompt.messageId && m.text.startsWith("Done"), 90_000);
    const root = path.join(baseDir, "Instagram", "demo.person");
    expect(summary.text).toMatch(/^Done: @demo\.person profile backup — 12 files saved\.\nFolder: /);
    expect(summary.text).toContain(root);
    // the prompt was edited in place (no message of its own for the job) to the job's final words, without buttons;
    // the demo is quick, so its progress edit may fold into the last one
    expect(callsTo(fake, "editMessageText", OWNER).some((c) => c.body.message_id === prompt.messageId)).toBe(true);
    const final = fake.sent(OWNER).find((m) => m.messageId === prompt.messageId)!;
    expect(final.text).toBe("@demo.person profile backup\n12 files saved");
    expect(final.keyboard).toBeUndefined();
    expect(fake.sent(OWNER).filter((m) => m.text.startsWith("@demo.person profile backup"))).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual(["Highlights", "Tagged", "p1.png", "p2.png", "p3.png", "p4.png", "p5.png", "p6.png"]);
    expect(readdirSync(path.join(root, "Highlights"))).toHaveLength(4);
    expect(readdirSync(path.join(root, "Tagged")).sort()).toEqual(["p1.png", "p2.png"]);
  });
});

test("ignores other chats", async () => {
  await withBot(BOUND, async ({ fake, userData, baseDir }) => {
    await saveToken(userData);
    fake.text(OWNER, "demo.person");
    const prompt = await message(fake, (m) => m.text.startsWith("@demo.person — what should TurboDL save?"));
    const start = callbackData(prompt, "Start");

    fake.text(STRANGER, "demo.person");
    fake.text(STRANGER, "/help");
    fake.text(STRANGER, "/start 123456");
    // a button from the stranger's own chat, and the stranger pressing the owner's prompt (as if it was forwarded)
    fake.press(STRANGER, prompt.messageId, start);
    fake.press(OWNER, prompt.messageId, start, STRANGER);
    // updates are handled in turn: once the owner's /help is answered, the stranger's have been read
    const before = fake.sent(OWNER).length;
    fake.text(OWNER, "/help");
    await expect.poll(() => fake.sent(OWNER).slice(before).some((m) => m.text.startsWith(HELP_START)), { timeout: 15_000 }).toBe(true);

    expect(fake.calls.filter((c) => Number(c.body.chat_id) === STRANGER)).toEqual([]);
    expect(fake.calls.filter((c) => c.method === "answerCallbackQuery")).toEqual([]);
    // nothing started: the owner's prompt is as it was, and nothing was saved
    expect(callsTo(fake, "editMessageText", OWNER)).toEqual([]);
    expect(fake.sent(OWNER).find((m) => m.messageId === prompt.messageId)).toEqual(prompt);
    expect(existsSync(path.join(baseDir, "Instagram"))).toBe(false);
  });
});

test("backs up a .txt list", async () => {
  test.setTimeout(240_000);
  await withBot({ ...BOUND, listWait: { min: 0, max: 0 } }, async ({ fake, userData, baseDir }) => {
    await saveToken(userData);
    fake.document(OWNER, "list.txt", Buffer.from("# two demo profiles\ndemo.person\nnot a name!\nhttps://www.instagram.com/demo.plain/\n"));
    const prompt = await message(fake, (m) => m.text.startsWith("List: 2 profiles"));
    expect(prompt.text).toContain("1 line wasn't a profile: not a name!");
    expect(prompt.text).toContain("Wait between profiles: 0–0 min");
    expect(buttons(prompt)).toEqual(["✓ Posts", "✓ Highlights", "✓ Tagged", "✓ Photos", "✓ Videos", "Wait 0–0 min", "Start", "Cancel"]);
    fake.press(OWNER, prompt.messageId, callbackData(prompt, "Start"));

    // the prompt becomes the list message, which follows the list
    await expect.poll(() => fake.sent(OWNER).find((m) => m.messageId === prompt.messageId)?.text.startsWith("List: list - ") ?? false, { timeout: 15_000 }).toBe(true);
    // the app's own notice when it finishes, as a message of its own
    const notice = await message(fake, (m) => m.text === "Profile list finished: 2 backed up, 0 skipped.", 180_000);
    expect(notice.messageId).toBeGreaterThan(prompt.messageId);
    expect(notice.replyTo).toBeUndefined();
    await expect.poll(() => fake.sent(OWNER).find((m) => m.messageId === prompt.messageId)?.text.split("\n")[0], { timeout: 15_000 }).toBe("List: list - finished");
    const listMessage = fake.sent(OWNER).find((m) => m.messageId === prompt.messageId)!;
    expect(listMessage.text).toContain("2/2 profiles");
    expect(listMessage.text).toContain("@demo.person - done");
    expect(listMessage.text).toContain("@demo.plain - done");
    expect(buttons(listMessage)).toEqual(["Close"]);
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.person")).length).toBeGreaterThan(0);
    expect(readdirSync(path.join(baseDir, "Instagram", "demo.plain")).length).toBeGreaterThan(0);
  });
});

test("shows the Telegram section in Settings", async () => {
  await withBot({}, async ({ app, fake, userData }) => {
    await turbodl(userData, ["telegram", "token"], `${TOKEN}\n`);
    const chat = await turbodl(userData, ["telegram", "chat", String(OWNER)]);
    expect(chat.code, chat.stderr).toBe(0);
    const on = await turbodl(userData, ["telegram", "on"]);
    expect(on.code, on.stderr).toBe(0);
    await expect.poll(async () => (await telegramStatus(userData)).state, { timeout: 15_000 }).toBe("ok");

    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Settings" }).click();
    const dialog = main.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("heading", { name: "Telegram" })).toBeVisible();
    await expect(dialog.getByText(`Connected as @${fake.bot.username}.`)).toBeVisible();
    await expect(dialog.getByText(`Bound to ${OWNER}`)).toBeVisible();
    await expect(dialog.getByText(`Saved (@${fake.bot.username})`)).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "Enable the Telegram bot" })).toBeChecked();
    // the token never reaches the window
    expect(await main.content()).not.toContain(TOKEN);
  });
});

test("turning the bot off stops it answering", async () => {
  await withBot(BOUND, async ({ fake, userData }) => {
    await saveToken(userData);
    fake.text(OWNER, "/help");
    await message(fake, (m) => m.text.startsWith(HELP_START));

    const off = await turbodl(userData, ["telegram", "off"]);
    expect(off.code, off.stderr).toBe(0);
    expect(off.stdout).toContain("State: off");
    // the command returns once the bot has stopped: it no longer asks Telegram for anything
    const calls = fake.calls.length;
    const sent = fake.sent(OWNER).length;
    fake.text(OWNER, "demo.person");
    fake.text(OWNER, "/help");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(fake.sent(OWNER)).toHaveLength(sent);
    expect(fake.calls.slice(calls)).toEqual([]);
    expect(await telegramStatus(userData)).toMatchObject({ state: "off", enabled: false, chatId: OWNER, tokenSet: true });
  });
});

test("a saved token survives an app restart", async () => {
  const fake = await startFakeTelegram({ token: TOKEN });
  const env = { TURBODL_TELEGRAM_API: fake.url };
  let launched = await launchApp({}, env);
  const { userData } = launched;
  try {
    await appReady(launched);
    await turbodl(userData, ["telegram", "token"], `${TOKEN}\n`);
    const on = await turbodl(userData, ["telegram", "on"]);
    expect(on.code, on.stderr).toBe(0);
    await expect.poll(async () => (await telegramStatus(userData)).state, { timeout: 15_000 }).toBe("ok");
    // encrypted by the system, never kept in plain text
    const encrypted = path.join(userData, "telegram-token.bin");
    expect(existsSync(encrypted)).toBe(true);
    expect(existsSync(path.join(userData, "telegram-token"))).toBe(false);
    expect(readFileSync(encrypted).includes(TOKEN)).toBe(false);
    for (const file of ["settings.json", "api.json", "telegram-state.json"]) {
      if (existsSync(path.join(userData, file))) expect(readFileSync(path.join(userData, file), "utf8"), file).not.toContain(TOKEN);
    }

    await launched.app.close();
    const asked = fake.calls.filter((c) => c.method === "getMe").length;
    launched = await launchApp({}, env, { userData });
    await appReady(launched);
    // the token read back (decrypted) reaches the bot: Telegram accepts only that token
    await expect.poll(() => telegramStatus(userData), { timeout: 20_000 }).toMatchObject({ state: "ok", tokenSet: true, enabled: true, bot: fake.bot.username });
    expect(fake.calls.filter((c) => c.method === "getMe").length).toBeGreaterThan(asked);
    expect(JSON.stringify(await telegramStatus(userData))).not.toContain(TOKEN);
  } finally {
    await launched.app.close().catch(() => undefined);
    await fake.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

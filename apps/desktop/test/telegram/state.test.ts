import { describe, expect, it } from "vitest";
import { EMPTY_STATE, isBotStateFile, type BotStateFile } from "../../src/main/telegram/state";

const job = { jobId: "job1", chatId: 7, messageId: 5, kind: "file", label: "example.com a.zip" };

describe("bot state file", () => {
  it("takes the flags an open job may carry", () => {
    const state: BotStateFile = { ...EMPTY_STATE, botId: 1, jobs: [{ ...job, kind: "file", started: true }, { ...job, kind: "file", started: true, ended: true }] };
    expect(isBotStateFile(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(isBotStateFile({ ...EMPTY_STATE, jobs: [job] })).toBe(true);
  });

  it("refuses a flag that isn't true", () => {
    for (const flags of [{ started: false }, { started: 1 }, { ended: false }, { ended: "yes" }]) {
      expect(isBotStateFile({ ...EMPTY_STATE, jobs: [{ ...job, ...flags }] })).toBe(false);
    }
  });
});

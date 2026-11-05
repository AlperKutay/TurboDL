import type { JobKind } from "@turbodl/shared";

/** A job the bot started and still shows a progress message for. */
export interface OpenJob {
  jobId: string;
  chatId: number;
  messageId: number;
  kind: JobKind;
  label: string;
  /** the job has ended and its last words were on their way: a restart must not call it unfinished */
  ended?: true;
  /** the job got as far as a file or some progress: a link job's download is then in the app's list and resumes there */
  started?: true;
}

/** What the bot keeps between runs (`<userData>/telegram-state.json`). */
export interface BotStateFile {
  /** the bot the state belongs to; another bot starts from scratch */
  botId: number | null;
  /** the next getUpdates offset: updates below it are handled */
  offset: number;
  jobs: OpenJob[];
  /** the list message in the chat, and whether the bot still follows the list */
  list: { chatId: number; messageId: number; active: boolean } | null;
}

export const EMPTY_STATE: BotStateFile = { botId: null, offset: 0, jobs: [], list: null };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isOpenJob(v: unknown): v is OpenJob {
  return (
    isObject(v) &&
    typeof v.jobId === "string" &&
    isInt(v.chatId) &&
    isInt(v.messageId) &&
    typeof v.kind === "string" &&
    typeof v.label === "string" &&
    (v.ended === undefined || v.ended === true) &&
    (v.started === undefined || v.started === true)
  );
}

export function isBotStateFile(v: unknown): v is BotStateFile {
  if (!isObject(v)) return false;
  if (v.botId !== null && !isInt(v.botId)) return false;
  if (!isInt(v.offset) || v.offset < 0) return false;
  if (!Array.isArray(v.jobs) || !v.jobs.every(isOpenJob)) return false;
  if (v.list === null) return true;
  return isObject(v.list) && isInt(v.list.chatId) && isInt(v.list.messageId) && typeof v.list.active === "boolean";
}

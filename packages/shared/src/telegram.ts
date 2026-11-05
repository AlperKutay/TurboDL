/**
 * What the app keeps about the Telegram bot. The token is never here: it has a file of its own, encrypted by the
 * system when the system can encrypt, else in plain text that only the user can read.
 */
export interface TelegramSettings {
  enabled: boolean;
  /** the one private chat the bot answers; null until a chat is paired */
  chatId: number | null;
}

export const DEFAULT_TELEGRAM: TelegramSettings = { enabled: false, chatId: null };

export type TelegramState = "off" | "noToken" | "connecting" | "ok" | "tokenRejected" | "tokenUnreadable" | "conflict" | "offline";

/** how long a pairing code is valid */
export const PAIRING_MS = 10 * 60 * 1000;

export interface TelegramPairing {
  code: string;
  expiresAt: number;
}

export interface TelegramStatus {
  state: TelegramState;
  tokenSet: boolean;
  bot?: string;
  chatId: number | null;
  enabled: boolean;
  pairing?: TelegramPairing;
  /** when a chat last paired with the bot (epoch ms, the app's clock); kept until the app quits */
  pairedAt?: number;
  error?: string;
}

export type TelegramPairResult = ({ ok: true; bot?: string } & TelegramPairing) | { ok: false; error: string };

/** Null for a positive safe integer; otherwise why it is not a chat id. */
export function chatIdProblem(v: unknown): string | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? null : "A chat id is a whole number above 0.";
}

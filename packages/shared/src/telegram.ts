/** What the app keeps about the Telegram bot (the token itself lives in the OS keychain, never here). */
export interface TelegramSettings {
  enabled: boolean;
  /** the one private chat the bot answers; null until a chat is paired */
  chatId: number | null;
}

export const DEFAULT_TELEGRAM: TelegramSettings = { enabled: false, chatId: null };

export type TelegramState = "off" | "noToken" | "connecting" | "ok" | "tokenRejected" | "tokenUnreadable" | "conflict" | "offline";

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
  error?: string;
}

export type TelegramPairResult = ({ ok: true; bot?: string } & TelegramPairing) | { ok: false; error: string };

/** Null for a positive safe integer; otherwise why it is not a chat id. */
export function chatIdProblem(v: unknown): string | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? null : "A chat id is a whole number above 0.";
}

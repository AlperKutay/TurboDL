import type { TgMessage, Update } from "./types";

export type OwnerUpdate =
  | { type: "message"; message: TgMessage }
  | { type: "press"; id: string; chatId: number; messageId: number; data: string };

/** Only updates from the bound private chat; for presses the presser must be that chat's user too. Everything else gets no reply. */
export function ownerUpdate(update: Update, chatId: number | null): OwnerUpdate | null {
  if (chatId === null) return null;
  const message = update.message;
  if (message) {
    return message.chat.type === "private" && message.chat.id === chatId ? { type: "message", message } : null;
  }
  const press = update.callback_query;
  const origin = press?.message;
  if (press && origin && press.data !== undefined) {
    if (origin.chat.type === "private" && origin.chat.id === chatId && press.from.id === chatId) {
      return { type: "press", id: press.id, chatId, messageId: origin.message_id, data: press.data };
    }
  }
  return null;
}

/** "/start 123456" or "/start@bot 123456" from any private chat. */
export function pairingStart(update: Update): { chatId: number; code: string } | null {
  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.text) return null;
  const m = /^\/start(?:@\w+)?\s+(\d{6})\s*$/i.exec(message.text.trim());
  return m ? { chatId: message.chat.id, code: m[1] } : null;
}

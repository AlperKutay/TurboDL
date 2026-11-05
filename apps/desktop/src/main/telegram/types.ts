/** The parts of the Telegram Bot API objects TurboDL reads. */
export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TgUser {
  id: number;
  username?: string;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  document?: TgDocument;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type Keyboard = InlineButton[][];

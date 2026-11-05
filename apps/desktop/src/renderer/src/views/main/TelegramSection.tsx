import { useEffect, useState } from "react";
import type { Result, TelegramPairResult, TelegramState, TelegramStatus } from "@turbodl/shared";
import { api } from "../../api";

const STATE_TEXT: Record<Exclude<TelegramState, "ok">, string> = {
  off: "Off.",
  noToken: "No bot token yet.",
  connecting: "Connecting…",
  tokenRejected: "Telegram rejected the token.",
  tokenUnreadable: "TurboDL couldn't read the saved token. Save it again.",
  conflict: "Another program is using this bot's token.",
  offline: "Can't reach Telegram; trying again.",
};

function statusLine(status: TelegramStatus): string {
  return status.state === "ok" ? `Connected as @${status.bot ?? "bot"}.` : STATE_TEXT[status.state];
}

/** The Telegram bot's settings. They save through their own calls (never the Settings window's Save); the token is never kept here. */
export function TelegramSection({ status }: { status: TelegramStatus }) {
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [chat, setChat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const pairing = status.chatId === null ? status.pairing : undefined;
  const expiresAt = pairing?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const wait = expiresAt - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const run = async (action: () => Promise<Result | TelegramPairResult>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await action();
      setError(result.ok ? "" : result.error);
      return result.ok;
    } catch {
      setError("Couldn't change the Telegram bot.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveToken = async () => {
    const value = token.trim();
    if (!value) return;
    const sent = value;
    setToken("");
    if (await run(() => api.telegramSetToken(sent))) setReplacing(false);
  };

  const bind = async () => {
    const id = Number(chat.trim());
    if (!chat.trim() || !Number.isFinite(id)) {
      setError("A chat id is a whole number above 0.");
      return;
    }
    if (await run(() => api.telegramSetChat(id))) setChat("");
  };

  const showTokenField = !status.tokenSet || replacing;
  const pairingOpen = pairing !== undefined && pairing.expiresAt > now;

  return (
    <>
      <h3>Telegram</h3>
      <label className="check">
        <input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => void run(() => api.telegramSetEnabled(e.target.checked))} />
        Enable the Telegram bot
      </label>
      <p className="muted field-note">Create a bot with @BotFather in Telegram, paste its token here, then pair your chat.</p>

      <div className="install-box">
        {showTokenField ? (
          <label className="field">
            <span>Bot token</span>
            <div className="field-row">
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !token.trim()} onClick={() => void saveToken()}>
                Save token
              </button>
              {replacing && (
                <button type="button" className="btn" disabled={busy} onClick={() => { setReplacing(false); setToken(""); }}>
                  Cancel
                </button>
              )}
            </div>
          </label>
        ) : (
          <div className="field-row">
            <span>Saved{status.bot ? ` (@${status.bot})` : ""}</span>
            <button type="button" className="btn" disabled={busy} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.telegramSetToken(null))}>
              Remove
            </button>
          </div>
        )}

        {status.chatId !== null ? (
          <div className="field-row">
            <span>Bound to {status.chatId}</span>
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.telegramSetChat(null))}>
              Unpair
            </button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Chat</span>
              <div className="field-row">
                <input type="number" value={chat} onChange={(e) => setChat(e.target.value)} />
                <button type="button" className="btn" disabled={busy || !chat.trim()} onClick={() => void bind()}>
                  Bind
                </button>
                <button type="button" className="btn" disabled={busy || !status.tokenSet} onClick={() => void run(() => api.telegramPair())}>
                  Pair
                </button>
              </div>
            </label>
            {pairingOpen && (
              <p className="muted">
                Send /start {pairing.code} to @{status.bot ?? "your bot"} in Telegram.
              </p>
            )}
          </>
        )}

        <p className="muted">{statusLine(status)}</p>
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}

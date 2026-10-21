import { useEffect, useState } from "react";
import type { InstagramFindResult, InstagramItem, PendingInstagram } from "@turbodl/shared";
import { api } from "../api";
import { Icon } from "../components/Icon";
import "./dialogs.css";

const TITLES: Record<PendingInstagram["link"]["kind"], string> = {
  post: "Instagram post",
  story: "Instagram story",
  highlight: "Instagram highlight",
  profile: "Instagram profile",
  saved: "Instagram saved posts",
};

function length(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What a tile and the large preview show: the photo itself, or a video's cover. */
const picture = (item: InstagramItem, large: boolean) => (item.kind === "image" ? (large ? item.url : (item.thumbnail ?? item.url)) : item.thumbnail);

/**
 * An Instagram post's, story's or highlight's photos and videos, read from its signed-in page: tap to pick
 * (numbered), hover to see one large; nothing picked downloads them all.
 */
export function InstagramWindow({ pendingId }: { pendingId: string }) {
  const [pending, setPending] = useState<PendingInstagram | null | undefined>(undefined);
  const [result, setResult] = useState<InstagramFindResult | "loading">("loading");
  const [picked, setPicked] = useState<number[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    setResult("loading");
    setError(null);
    setResult(await api.findInstagram(pendingId));
  };

  useEffect(() => {
    document.title = "Instagram";
    void api.getPending(pendingId).then((p) => {
      if (!p || p.type !== "instagram") {
        setPending(null);
        return;
      }
      setPending(p);
      void find();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.cancelPending(pendingId).then(() => api.closeWindow());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  const cancel = () => void api.cancelPending(pendingId).then(() => api.closeWindow());

  if (pending === undefined) return <div className="dialog loading">Loading…</div>;
  if (pending === null || result !== "loading" && result.type === "gone") {
    return (
      <div className="dialog">
        <p>This request no longer exists.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => void api.closeWindow()}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const items = result !== "loading" && result.type === "items" ? result.items : [];
  const toggle = (index: number) => setPicked((list) => (list.includes(index) ? list.filter((i) => i !== index) : [...list, index]));
  const signIn = async () => {
    setBusy(true);
    const ok = await api.instagramSignIn(pendingId);
    setBusy(false);
    if (ok) await find();
    else setError("Not signed in to Instagram.");
  };
  const submit = async (mode: "now" | "later") => {
    setBusy(true);
    setError(null);
    const res = await api.confirmInstagram(pendingId, picked, mode);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
    }
  };
  const large = viewing !== null ? items[viewing] : undefined;

  return (
    <div className="dialog instagram">
      <div className="dialog-head">
        <div className="dialog-icon">
          <Icon name="image" size={22} />
        </div>
        <div>
          <h1>{TITLES[pending.link.kind]}</h1>
          <p className="muted url" title={pending.pageUrl}>
            {pending.pageUrl}
          </p>
        </div>
      </div>

      {result === "loading" && <p className="muted spinner">Reading Instagram…</p>}
      {result !== "loading" && result.type === "signedOut" && (
        <section>
          <p>
            {result.at
              ? "Instagram wants to check it's you before it shows this page."
              : "Instagram shows this only to signed-in visitors. Sign in to read it, or, if you are signed in in your browser, use “Open in TurboDL” there."}
          </p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn()}>
            {result.at ? "Continue on Instagram" : "Sign in to Instagram"}
          </button>
        </section>
      )}
      {result !== "loading" && result.type === "nothing" && (
        <p className="muted">
          Nothing to download on this page.{" "}
          <button type="button" className="link-button" onClick={() => void find()}>
            Try again
          </button>
          {" · "}
          <button type="button" className="link-button" disabled={busy} onClick={() => void signIn()}>
            Sign in again
          </button>
        </p>
      )}
      {items.length > 0 && (
        <>
          <ul className="ig-grid">
            {items.map((item, i) => {
              const number = picked.indexOf(i);
              const cover = picture(item, false);
              return (
                <li key={`${item.url}-${i}`}>
                  <button
                    type="button"
                    className="ig-tile"
                    aria-label={`Item ${i + 1}`}
                    aria-pressed={number >= 0}
                    onClick={() => toggle(i)}
                    onMouseEnter={() => setViewing(i)}
                    onMouseLeave={() => setViewing(null)}
                  >
                    {cover ? <img src={cover} alt="" draggable={false} /> : <span className="ig-blank" />}
                    <span className="ig-pick">{number >= 0 ? number + 1 : ""}</span>
                    {item.kind === "video" && <span className="ig-badge">▶ {item.duration !== undefined ? length(item.duration) : "Video"}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted">Click to pick · hover to see it large</p>
        </>
      )}
      {large && picture(large, true) && (
        <div className="ig-large" aria-hidden="true">
          <img src={picture(large, true)} alt="" />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={() => void submit("later")} disabled={busy || items.length === 0}>
          Download later
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void submit("now")} disabled={busy || items.length === 0}>
          {picked.length === 0 ? `Download all ${items.length}` : `Download ${picked.length}`}
        </button>
      </div>
    </div>
  );
}

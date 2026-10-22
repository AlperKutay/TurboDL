/** What an Instagram address points at. Post and story links under a username are posts and stories, not profiles. */
export type InstagramLink =
  | { kind: "post"; code: string }
  | { kind: "story"; username: string; item: string }
  | { kind: "highlight"; id: string }
  | { kind: "profile"; username: string }
  | { kind: "saved"; username: string };

/** Instagram's own first path parts, which are never usernames. */
const RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "s", "explore", "accounts", "direct", "about", "legal", "developer", "web", "api",
  "challenge", "emails", "privacy", "terms", "ar", "music", "audio", "locations", "topics",
]);
const POST_PARTS = ["p", "reel", "reels", "tv"];
const USERNAME = /^[a-z0-9._]{1,30}$/i;

export function parseInstagramLink(address: string): InstagramLink | null {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "s" && parts[1]) return sharedHighlight(parts[1]);
  if (parts[0] === "stories" && parts.length >= 3) {
    return parts[1] === "highlights" ? { kind: "highlight", id: parts[2] } : { kind: "story", username: parts[1], item: parts[2] };
  }
  const postAt = parts.findIndex((p) => POST_PARTS.includes(p));
  if (postAt >= 0 && postAt + 1 < parts.length && postAt <= 1) return { kind: "post", code: parts[postAt + 1] };
  const name = parts[0]?.toLowerCase();
  if (!name || RESERVED.has(name) || !USERNAME.test(name)) return null;
  if (parts[1] === "saved") return { kind: "saved", username: name };
  if (parts.length === 1 || (parts.length === 2 && (parts[1] === "reels" || parts[1] === "tagged"))) return { kind: "profile", username: name };
  return null;
}

/** The share sheet's `/s/<base64 of "highlight:<id>">`; the code may come URL-safe and without its padding. */
function sharedHighlight(code: string): InstagramLink | null {
  let text = code.replace(/-/g, "+").replace(/_/g, "/");
  text += "=".repeat((4 - (text.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(text);
  } catch {
    return null;
  }
  if (!decoded.startsWith("highlight:")) return null;
  const id = decoded.slice("highlight:".length);
  return id ? { kind: "highlight", id } : null;
}

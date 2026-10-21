import { SavedError, savedPage, savedUsername, type BrowserCookie, type SavedPage, type SavedSource } from "@turbodl/shared";
import { request } from "../engine/http";

/** A GET that answers the status and the body as text, so the client is tested without the network. */
export type HttpGet = (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; body: string }>;

const SITE = "https://www.instagram.com";
const APP_ID = "936619743392459";
const MAX_BODY = 16 * 1024 * 1024;

/** The engine's request, its body read as text (an answer past 16 MB is refused). */
export const httpGet: HttpGet = async (url, headers, signal) => {
  const res = await request(url, { headers, signal });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      res.body.destroy();
      throw new Error("Instagram's answer is too large.");
    }
    chunks.push(chunk as Buffer);
  }
  return { status: res.status, body: Buffer.concat(chunks).toString("utf8") };
};

/** Instagram's saved feeds, asked the way its web site asks them, with the kept session. */
export class SavedClient {
  constructor(
    private readonly cookies: () => BrowserCookie[],
    private readonly agent: string,
    private readonly get: HttpGet = httpGet,
  ) {}

  /** One page of All or of a collection; `cursor` is the previous page's `next`. */
  async page(source: SavedSource, cursor?: string, signal?: AbortSignal): Promise<SavedPage> {
    let path = source.kind === "all" ? "/api/v1/feed/saved/posts/" : `/api/v1/feed/collection/${encodeURIComponent(source.id)}/posts/`;
    if (cursor) path += `?max_id=${escapeAll(cursor)}`;
    const { status, body } = await this.get(SITE + path, this.headers(), signal);
    return savedPage(body, status);
  }

  /** The signed-in account's username (the collections page is under it). */
  async username(signal?: AbortSignal): Promise<string> {
    const { status, body } = await this.get(`${SITE}/api/v1/accounts/edit/web_form_data/`, this.headers(), signal);
    return savedUsername(body, status);
  }

  /** Throws signedOut before anything is sent when no session is alive. */
  private headers(): Record<string, string> {
    const now = Date.now() / 1000;
    const live = this.cookies().filter((c) => c.expires === 0 || c.expires > now);
    if (!live.some((c) => c.name === "sessionid" && c.value)) throw new SavedError("signedOut");
    return {
      Cookie: live.map((c) => `${c.name}=${c.value}`).join("; "),
      "X-IG-App-ID": APP_ID,
      "X-CSRFToken": live.find((c) => c.name === "csrftoken")?.value ?? "",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${SITE}/`,
      "User-Agent": this.agent,
    };
  }
}

/** Every character but letters and digits percent-encoded, as the iPhone app sends the cursor. */
function escapeAll(text: string): string {
  return encodeURIComponent(text).replace(/[-_.!~*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

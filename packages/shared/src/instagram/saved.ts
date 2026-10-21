import { arr, dict, int, isJson, objectsInDocuments, parseDocument, str, url, type Json } from "./json";
import { preview, v1Items, type InstagramItem } from "./media";

/** Which saved posts: all of them, or one of the account's collections. */
export type SavedSource = { kind: "all" } | { kind: "collection"; id: string };

export interface SavedPost {
  id: string;
  code?: string;
  /** a small version of the post's picture, for grids */
  cover?: string;
  /** every item has a `mediaId`: a carousel child's `pk`, or the post's own */
  items: InstagramItem[];
}

/** One page of a saved feed; `next` is the following page's cursor, absent on the last one. */
export interface SavedPage {
  posts: SavedPost[];
  next?: string;
}

/** "All posts" or one of the account's own collections. */
export interface SavedCollection {
  id: string;
  name: string;
  /** how many posts it holds, when Instagram says */
  count?: number;
  cover?: string;
  isAll: boolean;
}

/** Why Instagram gave no page: the session is gone, it asked to slow down, an HTTP error, or an answer it can't be. */
export class SavedError extends Error {
  constructor(
    readonly kind: "signedOut" | "rateLimited" | "http" | "badAnswer",
    readonly status?: number,
  ) {
    super(kind === "http" ? `Instagram answered HTTP ${status}.` : kind);
    this.name = "SavedError";
  }
}

/** A page of `/api/v1/feed/saved/posts/` or `/api/v1/feed/collection/<id>/posts/`. */
export function savedPage(body: string, status: number): SavedPage {
  const answer = check(body, status);
  const posts = arr(answer.items)
    .map((entry) => dict(entry, "media"))
    .flatMap((media) => (media ? (savedPost(media) ?? []) : []));
  const next = answer.more_available === true ? str(answer.next_max_id) : undefined;
  return next ? { posts, next } : { posts };
}

/** The signed-in account's username, from `/api/v1/accounts/edit/web_form_data/`. */
export function savedUsername(body: string, status: number): string {
  const name = str(dict(check(body, status), "form_data")?.username);
  if (!name) throw new SavedError("badAnswer");
  return name;
}

/**
 * The collections the desktop saved page lists (`collections_unified_with_auto_collections`), All first as listed,
 * audio left out; `hasMore` is what the last list in the documents says.
 */
export function savedCollections(documents: string[]): { list: SavedCollection[]; hasMore: boolean } {
  const containers = objectsInDocuments(documents, (o) => isJson(o.collections_unified_with_auto_collections))
    .map((o) => dict(o, "collections_unified_with_auto_collections"))
    .filter((c): c is Json => c !== undefined);
  const list: SavedCollection[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    for (const node of arr(container.edges).map((edge) => dict(edge, "node"))) {
      const found = node && collection(node);
      if (!found || seen.has(found.id)) continue;
      seen.add(found.id);
      list.push(found);
    }
  }
  const hasMore = dict(containers[containers.length - 1], "page_info")?.has_next_page === true;
  return { list, hasMore };
}

/** A saved post and its items; none for a post without anything to save. */
export function savedPost(media: Json): SavedPost | undefined {
  const id = str(media.pk);
  if (!id) return undefined;
  const items = v1Items(media).map((item) => ({ ...item, mediaId: item.mediaId ?? id }));
  if (items.length === 0) return undefined;
  const cover = preview(candidates(media)) ?? items[0].thumbnail ?? items[0].url;
  const code = str(media.code);
  return { id, ...(code ? { code } : {}), cover, items };
}

function collection(node: Json): SavedCollection | undefined {
  const type = str(node.__typename);
  if (type !== "IGAllMediaAutoCollection" && type !== "MediaCollection") return undefined;
  const id = str(node.collection_id);
  if (!id) return undefined;
  const coverMedia = dict(node, "cover_media") ?? arr(node.cover_media_list)[0];
  const pictures = coverMedia ? candidates(coverMedia) : [];
  const cover = preview(pictures) ?? pictures.map((p) => url(p.url)).find(Boolean);
  const count = int(node.collection_media_count);
  return { id, name: str(node.collection_name) ?? "", ...(count !== undefined ? { count } : {}), ...(cover ? { cover } : {}), isAll: type === "IGAllMediaAutoCollection" };
}

function candidates(media: Json): Json[] {
  return arr(dict(media, "image_versions2")?.candidates);
}

/** The answer as an object, or why there is none (first rule that matches wins). */
function check(body: string, status: number): Json {
  const parsed = parseDocument(body);
  const answer = isJson(parsed) ? parsed : undefined;
  pushBack(answer, status);
  // a page instead of an answer is the sign-in page
  if (!answer) throw new SavedError("signedOut");
  if (str(answer.status) !== "ok") throw new SavedError("badAnswer");
  return answer;
}

/** Instagram asking to slow down, the session gone, or an HTTP error (first rule that matches wins). */
export function pushBack(answer: Json | undefined, status: number): void {
  const message = (str(answer?.message) ?? "").toLowerCase();
  if (status === 429) throw new SavedError("rateLimited");
  if (message.includes("wait") || message.includes("feedback_required") || answer?.spam === true) throw new SavedError("rateLimited");
  if (status === 401 || status === 403 || answer?.require_login === true || message.includes("login_required")) throw new SavedError("signedOut");
  if (status < 200 || status > 299) throw new SavedError("http", status);
}

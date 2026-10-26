import { arr, dict, int, isJson, objectsIn, objectsInDocuments, parseDocument, str, url, type Json } from "./json";
import { SavedError, pushBack, savedPost, type SavedPost } from "./saved";

/** Someone's Instagram profile as its page shows it to the signed-in account. */
export interface InstagramProfile {
  /** the account's number (`pk`); it stays when the username changes */
  id: string;
  username: string;
  fullName: string;
  isPrivate: boolean;
  /** the signed-in account follows this one */
  following: boolean;
  picture?: string;
  postCount?: number;
}

/** One of a profile's highlights, as its tray lists it. */
export interface Highlight {
  /** the digits of `highlight:<digits>`, as in the highlight's own page address */
  id: string;
  title: string;
  cover?: string;
}

/** Posts from the profile page, and where the next ones start. */
export interface ProfilePosts {
  posts: SavedPost[];
  cursor?: string;
  hasNext: boolean;
}

const POSTS = "xdt_api__v1__feed__user_timeline_graphql_connection";

/** Private and not followed: Instagram shows no posts. */
export function isLocked(profile: InstagramProfile): boolean {
  return profile.isPrivate && !profile.following;
}

/**
 * The shared profile in the page's documents: an account with a friendship status (so not the signed-in one) whose
 * username is the link's, the one with a post count first (suggested accounts and posts' owners have none).
 */
export function profileIn(documents: string[], username: string): InstagramProfile | undefined {
  const name = username.toLowerCase();
  const users = objectsInDocuments(documents, (o) => isJson(o.friendship_status) && str(o.username)?.toLowerCase() === name);
  const user = users.find((u) => u.media_count !== undefined) ?? users[0];
  const id = user && (str(user.pk) ?? str(user.id));
  if (!user || !id) return undefined;
  const picture = url(user.profile_pic_url);
  const postCount = int(user.media_count);
  return {
    id,
    username: str(user.username) ?? username,
    fullName: str(user.full_name) ?? "",
    isPrivate: user.is_private === true,
    following: dict(user, "friendship_status")?.following === true,
    ...(picture ? { picture } : {}),
    ...(postCount !== undefined ? { postCount } : {}),
  };
}

/** Every posts connection in the documents, in order, each post once; the cursor is the last connection's. */
export function profilePosts(documents: string[]): ProfilePosts | undefined {
  return postsOf(objectsInDocuments(documents, (o) => isJson(o[POSTS])));
}

/** The answer to the page's posts request sent again. */
export function profilePostsAnswer(body: string, status: number): ProfilePosts {
  const parsed = parseDocument(body);
  const answer = isJson(parsed) ? parsed : undefined;
  pushBack(answer, status);
  if (!answer) throw new SavedError("signedOut");
  const posts = postsOf(objectsIn([answer], (o) => isJson(o[POSTS])));
  if (!posts) throw new SavedError("badAnswer");
  return posts;
}

/** The profile's highlights tray (`data.highlights`), in its order; undefined while the page hasn't sent it. */
export function highlightsTray(documents: string[]): Highlight[] | undefined {
  const trays = objectsInDocuments(documents, (o) => Array.isArray(dict(o, "highlights")?.edges)).map((o) => dict(o, "highlights") as Json);
  const tray = trays[trays.length - 1];
  if (!tray) return undefined;
  return arr(tray.edges).flatMap((edge) => {
    const node = dict(edge, "node");
    const full = str(node?.id);
    if (!node || !full?.startsWith("highlight:")) return [];
    const cover = url(dict(node, "cover_media", "cropped_image_version")?.url);
    return [{ id: full.slice("highlight:".length), title: str(node.title) ?? "", ...(cover ? { cover } : {}) }];
  });
}

/** The profile as Instagram shows it to everyone (`xig_user_by_igid_v2`): the session is gone. */
export function signedOutProfileView(documents: string[], username: string): boolean {
  const name = username.toLowerCase();
  return objectsInDocuments(documents, (o) => str(dict(o, "xig_user_by_igid_v2")?.username)?.toLowerCase() === name).length > 0;
}

/** `containers`: the objects holding a posts connection, in document order. */
function postsOf(containers: Json[]): ProfilePosts | undefined {
  const connections = containers.map((c) => dict(c, POSTS)).filter((c): c is Json => c !== undefined);
  const last = connections[connections.length - 1];
  if (!last) return undefined;
  const seen = new Set<string>();
  const posts = connections.flatMap(edgePosts).filter((p) => !seen.has(p.id) && seen.add(p.id));
  const info = dict(last, "page_info");
  const cursor = str(info?.end_cursor);
  return { posts, ...(cursor ? { cursor } : {}), hasNext: info?.has_next_page === true };
}

function edgePosts(connection: Json): SavedPost[] {
  return arr(connection.edges).flatMap((edge) => {
    const node = dict(edge, "node");
    const post = node && savedPost(node);
    if (!post) return [];
    const pinned = Array.isArray(node.timeline_pinned_user_ids) && node.timeline_pinned_user_ids.length > 0;
    return [pinned ? { ...post, pinned: true } : post];
  });
}

/** The signed-out profile page's posts query, by name. */
export const SIGNED_OUT_POSTS_QUERY = "PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery";
/** The signed-out profile page's highlights tray query, by name. */
export const SIGNED_OUT_TRAY_QUERY = "PolarisLoggedOutProfileStoryHighlightsTrayContentPaginationQuery";

/**
 * A public profile as Instagram shows it to signed-out visitors (`data.xig_user_by_username`): the profile, its first
 * posts known only by their covers and kinds, and its highlights, with where each first page ends and whether more
 * follow. Undefined when the page doesn't show it that way.
 */
export function signedOutProfile(
  documents: string[],
  username: string,
): { profile: InstagramProfile; posts: SavedPost[]; highlights: Highlight[]; cursor?: string; hasNext: boolean; trayCursor?: string; trayHasNext: boolean } | undefined {
  const name = username.toLowerCase();
  const user = objectsInDocuments(documents, (o) => str(dict(o, "xig_user_by_username")?.username)?.toLowerCase() === name).map((o) => dict(o, "xig_user_by_username") as Json)[0];
  const id = user && (str(user.pk) ?? str(user.id));
  if (!user || !id) return undefined;
  const picture = url(user.profile_pic_url);
  const postCount = int(user.all_media_count);
  const profile: InstagramProfile = {
    id,
    username: str(user.username) ?? username,
    fullName: str(user.full_name) ?? "",
    isPrivate: user.is_private === true,
    following: false,
    ...(picture ? { picture } : {}),
    ...(postCount !== undefined ? { postCount } : {}),
  };
  const posts = signedOutCovers(dict(user, "polaris_ordered_timeline_connection") ?? {});
  const tray = signedOutHighlights(dict(user, "lox_highlights_connection") ?? {});
  return { profile, posts: posts.posts, highlights: tray.highlights, ...(posts.cursor ? { cursor: posts.cursor } : {}), hasNext: posts.hasNext, ...(tray.cursor ? { trayCursor: tray.cursor } : {}), trayHasNext: tray.hasNext };
}

/** An answer to the signed-out posts query: covers (`unread`), the cursor, more or not; throws as `profilePostsAnswer` does. */
export function signedOutPostsAnswer(body: string, status: number): ProfilePosts {
  const connection = connectionIn(body, status, "polaris_ordered_timeline_connection");
  return signedOutCovers(connection);
}

/** An answer to the signed-out tray query: highlights as the tray lists them; throws as `signedOutPostsAnswer` does. */
export function signedOutTrayAnswer(body: string, status: number): { highlights: Highlight[]; cursor?: string; hasNext: boolean } {
  return signedOutHighlights(connectionIn(body, status, "lox_highlights_connection"));
}

/** The operation id a script defines for `name` (`__d("<name>_instagramRelayOperation",[],(function(…){x.exports="<digits>"}),null)`). */
export function relayOperationId(script: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`__d\\("${escaped}_instagramRelayOperation",\\[\\],\\(function\\([^)]*\\)\\{[^}]*?\\.exports="(\\d+)"`).exec(script)?.[1];
}

/** The page's `lsd` token (`"LSD",[],{"token":"…"}` in its HTML). */
export function pageLsd(html: string): string | undefined {
  return /"LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1];
}

/** The first `key` connection in an answer to a signed-out query; pushback and pages instead of answers throw as elsewhere. */
function connectionIn(body: string, status: number, key: string): Json {
  const parsed = parseDocument(body);
  const answer = isJson(parsed) ? parsed : undefined;
  pushBack(answer, status);
  if (!answer) throw new SavedError("signedOut");
  const connection = dict(objectsIn([answer], (o) => isJson(o[key]))[0], key);
  if (!connection) throw new SavedError("badAnswer");
  return connection;
}

/** A signed-out posts connection as covers; `hasNext` and the cursor from its page info. */
function signedOutCovers(connection: Json): ProfilePosts {
  const posts = arr(connection.edges).flatMap((edge) => {
    const node = dict(edge, "node");
    const pk = node && (str(node.pk) ?? str(node.id)?.split("_")[0]);
    const code = node && str(node.code);
    if (!node || !pk || !code) return [];
    const cover = url(node.display_uri);
    const mediaType = int(node.media_type);
    return [{ id: pk, code, ...(cover ? { cover } : {}), items: [], unread: true as const, ...(mediaType !== undefined ? { mediaType } : {}) }];
  });
  const info = dict(connection, "page_info");
  const cursor = str(info?.end_cursor);
  return { posts, ...(cursor ? { cursor } : {}), hasNext: info?.has_next_page === true };
}

/** A signed-out highlights connection (`lox_highlights_connection`) as the tray lists it. */
function signedOutHighlights(connection: Json): { highlights: Highlight[]; cursor?: string; hasNext: boolean } {
  const highlights = arr(connection.edges).flatMap((edge) => {
    const node = dict(edge, "node");
    const full = str(node?.id);
    if (!node || !full) return [];
    const cover = url(node.cover_media_cropped_thumbnail_url);
    return [{ id: full.replace(/^highlight:/, ""), title: str(node.title) ?? "", ...(cover ? { cover } : {}) }];
  });
  const info = dict(connection, "page_info");
  const cursor = str(info?.end_cursor);
  return { highlights, ...(cursor ? { cursor } : {}), hasNext: info?.has_next_page === true };
}

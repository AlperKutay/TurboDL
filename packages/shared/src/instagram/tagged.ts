import { arr, dict, isJson, objectsIn, objectsInDocuments, parseDocument, type Json } from "./json";
import { connectionPosts, type ProfilePosts } from "./profile";
import { SavedError, pushBack, savedPost } from "./saved";

/** The connections under keys that name user tags (`xdt_api__v1__usertags__user_id__feed_connection` and the like). */
function connectionsIn(o: Json): Json[] {
  return Object.keys(o)
    .filter((key) => /usertags/i.test(key))
    .map((key) => dict(o, key))
    .filter((c): c is Json => c !== undefined && Array.isArray(c.edges));
}

/** The REST feed (`/api/v1/usertags/<id>/feed/`): `items` of media, with `more_available`. */
function isRestFeed(o: Json): boolean {
  return Array.isArray(o.items) && typeof o.more_available === "boolean";
}

function restPosts(feed: Json): ProfilePosts {
  const posts = arr(feed.items).flatMap((item) => (isJson(item) ? (savedPost(item) ?? []) : []));
  const next = feed.next_max_id;
  const cursor = typeof next === "string" ? next : typeof next === "number" ? String(next) : undefined;
  return { posts, ...(cursor ? { cursor } : {}), hasNext: feed.more_available === true && cursor !== undefined };
}

/** Tagged posts among `find`'s objects: a usertags connection first, else the REST feed. */
function postsIn(find: (match: (o: Json) => boolean) => Json[]): ProfilePosts | undefined {
  const graphql = connectionPosts(find((o) => connectionsIn(o).length > 0).flatMap(connectionsIn));
  if (graphql) return graphql;
  const feed = find(isRestFeed).pop();
  return feed && restPosts(feed);
}

/** Whether the answer holds a usertags connection (a key naming user tags whose value has `edges`), by the shape `taggedPosts` reads. */
export function hasTaggedConnection(answer: string): boolean {
  return objectsInDocuments([answer], (o) => connectionsIn(o).length > 0).length > 0;
}

/**
 * The posts the signed-in tagged page shows, recognised by shape (nobody has seen that page's queries): a connection
 * under a `usertags` key, or the REST feed's `items`. Undefined while the documents hold neither.
 */
export function taggedPosts(documents: string[]): ProfilePosts | undefined {
  return postsIn((match) => objectsInDocuments(documents, match));
}

/** The answer to the tagged page's own paging request sent again; throws as `profilePostsAnswer` does. */
export function taggedAnswer(body: string, status: number): ProfilePosts {
  const parsed = parseDocument(body);
  const answer = isJson(parsed) ? parsed : undefined;
  pushBack(answer, status);
  if (!answer) throw new SavedError("signedOut");
  const posts = postsIn((match) => objectsIn([answer], match));
  if (!posts) throw new SavedError("badAnswer");
  return posts;
}

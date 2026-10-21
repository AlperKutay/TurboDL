import { arr, dict, int, num, objectsInDocuments, str, url, type Json } from "./json";
import type { InstagramLink } from "./links";

/** One photo or video of a post or story, at its best version. */
export interface InstagramItem {
  kind: "video" | "image";
  url: string;
  width?: number;
  height?: number;
  duration?: number;
  /** a small version for pickers (at least 320 wide), or a video's cover */
  thumbnail?: string;
  /** Instagram's `pk`; backups and file names go by it */
  mediaId?: string;
  /** the story a story link points at */
  shared?: boolean;
}

/**
 * The post with this `code`, in either shape Instagram's pages use: the v1 API (`code`, `carousel_media`,
 * `video_versions`, `image_versions2`) or the older GraphQL one (`shortcode`, `edge_sidecar_to_children`,
 * `display_resources`). The first copy of the post that carries media counts; other posts on the page don't.
 */
export function postItems(documents: string[], code: string): InstagramItem[] {
  const posts = objectsInDocuments(documents, (o) => str(o.code) === code || str(o.shortcode) === code);
  for (const post of posts) {
    const items = post.code !== undefined ? v1Items(post) : graphItems(post);
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * A story's or highlight's items. Story pages list reels as `reels_media`; a share link's page as the nodes of
 * `xdt_api__v1__feed__reels_media__connection`.
 */
export function storyItems(
  documents: string[],
  link: Extract<InstagramLink, { kind: "story" }> | Extract<InstagramLink, { kind: "highlight" }>,
): InstagramItem[] {
  const listed = objectsInDocuments(documents, (o) => Array.isArray(o.reels_media)).flatMap((o) => arr(o.reels_media));
  const connected = objectsInDocuments(documents, (o) => dict(o, "xdt_api__v1__feed__reels_media__connection") !== undefined)
    .flatMap((o) => arr(dict(o, "xdt_api__v1__feed__reels_media__connection")?.edges))
    .map((edge) => dict(edge, "node"))
    .filter((node): node is Json => node !== undefined);
  const reels = [...listed, ...connected];
  const reel =
    link.kind === "highlight"
      ? reels.find((r) => str(r.id) === `highlight:${link.id}`)
      : (reels.find((r) => arr(r.items).some((item) => str(item.pk) === link.item)) ??
        reels.find((r) => str(dict(r, "user")?.username) === link.username && str(r.reel_type) !== "highlight_reel"));
  if (!reel) return [];
  return arr(reel.items).flatMap((media) => {
    const item = v1Item(media);
    if (!item) return [];
    return [link.kind === "story" && str(media.pk) === link.item ? { ...item, shared: true } : item];
  });
}

/** A carousel's children, or the post itself, each at its best version. */
export function v1Items(post: Json): InstagramItem[] {
  const children = arr(post.carousel_media);
  return (children.length > 0 ? children : [post]).flatMap((m) => v1Item(m) ?? []);
}

export function v1Item(media: Json): InstagramItem | undefined {
  const pictures = arr(dict(media, "image_versions2")?.candidates);
  const picture = widest(pictures, "width", "height", "url");
  const video = widest(arr(media.video_versions), "width", "height", "url");
  const mediaId = str(media.pk);
  if (video) {
    // Some pages list versions without sizes; the media's own size is the one saved then.
    return clean({
      kind: "video",
      url: video.url,
      width: video.width ?? int(media.original_width),
      height: video.height ?? int(media.original_height),
      duration: num(media.video_duration),
      thumbnail: picture?.url,
      mediaId,
    });
  }
  if (!picture) return undefined;
  return clean({ kind: "image", url: picture.url, width: picture.width, height: picture.height, thumbnail: preview(pictures) ?? picture.url, mediaId });
}

/** The smallest version still at least 320 wide, for pickers. */
export function preview(candidates: Json[]): string | undefined {
  let best: { url: string; width: number } | undefined;
  for (const c of candidates) {
    const address = url(c.url);
    const width = int(c.width) ?? 0;
    if (address && width >= 320 && (!best || width < best.width)) best = { url: address, width };
  }
  return best?.url;
}

function graphItems(post: Json): InstagramItem[] {
  const edges = arr(dict(post, "edge_sidecar_to_children")?.edges)
    .map((e) => dict(e, "node"))
    .filter((n): n is Json => n !== undefined);
  return (edges.length > 0 ? edges : [post]).flatMap((n) => graphItem(n) ?? []);
}

function graphItem(node: Json): InstagramItem | undefined {
  const cover = url(node.display_url);
  const video = url(node.video_url);
  if (node.is_video === true && video) {
    const size = dict(node, "dimensions");
    return clean({ kind: "video", url: video, width: int(size?.width), height: int(size?.height), duration: num(node.video_duration), thumbnail: cover });
  }
  const best = widest(arr(node.display_resources), "config_width", "config_height", "src");
  if (best) return clean({ kind: "image", url: best.url, width: best.width, height: best.height });
  return cover ? { kind: "image", url: cover } : undefined;
}

function widest(list: Json[], w: string, h: string, u: string): { url: string; width?: number; height?: number } | undefined {
  let best: { url: string; width?: number; height?: number; area: number } | undefined;
  for (const entry of list) {
    const address = url(entry[u]);
    if (!address) continue;
    const width = int(entry[w]);
    const height = int(entry[h]);
    const area = (width ?? 0) * (height ?? 0);
    if (!best || area > best.area) best = { url: address, width, height, area };
  }
  return best && { url: best.url, width: best.width, height: best.height };
}

/** Without the fields that came out undefined, so items compare and serialize plainly. */
function clean(item: InstagramItem): InstagramItem {
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) as unknown as InstagramItem;
}

/** Instagram's sign-in and check pages. */
export function isSignInPath(pathname: string): boolean {
  return pathname.startsWith("/accounts/login") || pathname.startsWith("/challenge");
}

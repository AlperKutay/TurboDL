import { getExtension, type InstagramItem } from "@turbodl/shared";

/** A photo's or video's extension, from its address (Instagram serves .jpg, .webp, .heic, .mp4). */
export function instagramExtension(item: InstagramItem): string {
  const ext = getExtension(new URL(item.url).pathname).toLowerCase();
  if (item.kind === "video") return ext === "mp4" || ext === "mov" ? ext : "mp4";
  return ["jpg", "jpeg", "png", "webp", "heic"].includes(ext) ? ext : "jpg";
}

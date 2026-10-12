import type { Category } from "@turbodl/shared";
import type { IconName } from "./components/Icon";

export const CATEGORY_ICONS: Record<Category, IconName> = {
  video: "video",
  music: "music",
  programs: "app",
  archives: "archive",
  documents: "doc",
  images: "image",
  other: "file",
};

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

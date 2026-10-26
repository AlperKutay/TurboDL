import { parseInstagramLink, type JobKind } from "@turbodl/shared";

const INSTAGRAM_KINDS: Record<string, JobKind> = {
  post: "instagramPost",
  story: "instagramStory",
  highlight: "instagramHighlight",
  profile: "instagramProfile",
  saved: "instagramSaved",
};

/** What a job for this address starts as; web jobs become "media" later, other Instagram pages fail in their runner. */
export function jobKindOf(url: string): JobKind {
  const link = parseInstagramLink(url);
  return (link && INSTAGRAM_KINDS[link.kind]) || "file";
}

export type Route = { view: "main" } | { view: "new" | "media" | "instagram"; id: string };

export function parseRoute(hash: string): Route {
  const m = /^#?\/(new|media|instagram)\/([^/?#]+)$/.exec(hash);
  if (!m) return { view: "main" };
  return { view: m[1] as "new" | "media" | "instagram", id: decodeURIComponent(m[2]) };
}

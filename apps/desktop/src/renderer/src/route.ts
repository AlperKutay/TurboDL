export type Route = { view: "main" } | { view: "new" | "media"; id: string };

export function parseRoute(hash: string): Route {
  const m = /^#?\/(new|media)\/([^/?#]+)$/.exec(hash);
  if (!m) return { view: "main" };
  return { view: m[1] as "new" | "media", id: decodeURIComponent(m[2]) };
}

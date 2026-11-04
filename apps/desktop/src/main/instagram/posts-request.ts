import { hasTaggedConnection } from "@turbodl/shared";

/** A request as the page sent it. */
export type SentRequest = { url: string; method: string; headers: Record<string, string>; body?: string };

/** The page's own request for its next posts (a profile's or a tagged tab's), as the page sent it. */
export type PagingRequest =
  | {
      kind: "graphql";
      url: string;
      /** only the headers the page set itself (`content-type`, `x-*`); the browser adds the rest */
      headers: Record<string, string>;
      /** the form body, `variables` among its fields */
      body: string;
    }
  | { kind: "rest"; url: string; headers: Record<string, string> };

const POSTS = "xdt_api__v1__feed__user_timeline_graphql_connection";

/** The headers the page set itself. */
function ownHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() === "content-type" || name.toLowerCase().startsWith("x-")));
}

/** A graphql POST whose `variables` carry a cursor (`after`) and whose answer satisfies `holds`. */
function graphqlPaging(sent: SentRequest, answer: string, holds: (answer: string) => boolean): PagingRequest | null {
  if (sent.method.toUpperCase() !== "POST" || !sent.url.includes("graphql") || !sent.body || !holds(answer)) return null;
  let variables: unknown;
  try {
    variables = JSON.parse(new URLSearchParams(sent.body).get("variables") ?? "null");
  } catch {
    return null;
  }
  if (typeof variables !== "object" || variables === null || !("after" in variables)) return null;
  return { kind: "graphql", url: sent.url, headers: ownHeaders(sent.headers), body: sent.body };
}

/**
 * The page's paging query for a profile's posts: a POST to a graphql address whose `variables` carry a cursor
 * (`after`; the first query has none and can't be sent again for more) and whose answer holds the posts. Null for any
 * other request.
 */
export function postsRequest(sent: SentRequest, answer: string): PagingRequest | null {
  return graphqlPaging(sent, answer, (a) => a.includes(POSTS));
}

/**
 * The tagged page's paging request, by shape: a graphql POST with a cursor whose answer holds a usertags connection, or a GET
 * of `/api/v1/usertags/...` whose answer has `items`. Null for any other request.
 */
export function taggedRequest(sent: SentRequest, answer: string): PagingRequest | null {
  const graphql = graphqlPaging(sent, answer, hasTaggedConnection);
  if (graphql) return graphql;
  if (sent.method.toUpperCase() !== "GET" || !answer.includes('"items"')) return null;
  let path: string;
  try {
    path = new URL(sent.url).pathname;
  } catch {
    return null;
  }
  if (!path.includes("/api/v1/usertags/")) return null;
  return { kind: "rest", url: sent.url, headers: ownHeaders(sent.headers) };
}

/**
 * Code for the page that sends the request again from after `cursor`, with the page's own credentials, and evaluates
 * to `{ status, text }`. Everything taken from Instagram goes in as JSON literals, never as code.
 */
export function resendScript(request: PagingRequest, cursor: string): string {
  let target = request.url;
  let init: Record<string, unknown>;
  if (request.kind === "graphql") {
    const form = new URLSearchParams(request.body);
    const variables = JSON.parse(form.get("variables") ?? "{}") as Record<string, unknown>;
    form.set("variables", JSON.stringify({ ...variables, after: cursor }));
    init = { method: "POST", headers: request.headers, body: form.toString(), credentials: "include" };
  } else {
    const address = new URL(request.url);
    address.searchParams.set("max_id", cursor);
    target = address.toString();
    init = { method: "GET", headers: request.headers, credentials: "include" };
  }
  return `fetch(${JSON.stringify(target)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, text: await r.text() }))`;
}

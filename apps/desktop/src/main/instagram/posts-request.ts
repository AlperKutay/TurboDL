/** The profile page's own request for its next posts, as the page sent it. */
export interface PostsRequest {
  url: string;
  /** only the headers the page set itself (`content-type`, `x-*`); the browser adds the rest */
  headers: Record<string, string>;
  /** the form body, `variables` among its fields */
  body: string;
}

const POSTS = "xdt_api__v1__feed__user_timeline_graphql_connection";

/**
 * The page's paging query for a profile's posts: a POST to a graphql address whose `variables` carry a cursor
 * (`after`; the first query has none and can't be sent again for more) and whose answer holds the posts. Null for any
 * other request.
 */
export function postsRequest(sent: { url: string; method: string; headers: Record<string, string>; body?: string }, answer: string): PostsRequest | null {
  if (sent.method.toUpperCase() !== "POST" || !sent.url.includes("graphql") || !sent.body || !answer.includes(POSTS)) return null;
  let variables: unknown;
  try {
    variables = JSON.parse(new URLSearchParams(sent.body).get("variables") ?? "null");
  } catch {
    return null;
  }
  if (typeof variables !== "object" || variables === null || !("after" in variables)) return null;
  const headers = Object.fromEntries(Object.entries(sent.headers).filter(([name]) => name.toLowerCase() === "content-type" || name.toLowerCase().startsWith("x-")));
  return { url: sent.url, headers, body: sent.body };
}

/**
 * Code for the page that sends the request again from after `cursor`, with the page's own credentials, and evaluates
 * to `{ status, text }`. Everything taken from Instagram goes in as JSON literals, never as code.
 */
export function resendScript(request: PostsRequest, cursor: string): string {
  const form = new URLSearchParams(request.body);
  const variables = JSON.parse(form.get("variables") ?? "{}") as Record<string, unknown>;
  form.set("variables", JSON.stringify({ ...variables, after: cursor }));
  const init = { method: "POST", headers: request.headers, body: form.toString(), credentials: "include" };
  return `fetch(${JSON.stringify(request.url)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, text: await r.text() }))`;
}

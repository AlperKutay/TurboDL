import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { postsRequest, resendScript, type PostsRequest } from "../../src/main/instagram/posts-request";

const POSTS_ANSWER = '{"data":{"xdt_api__v1__feed__user_timeline_graphql_connection":{"edges":[],"page_info":{"has_next_page":false}}}}';
const variables = { after: "cursor-1", before: null, data: { count: 12 }, first: 12, username: "sample.user" };
const body = new URLSearchParams({ av: "17841", fb_dtsg: "tok:en", variables: JSON.stringify(variables), doc_id: "9" }).toString();
const headers = {
  "Content-Type": "application/x-www-form-urlencoded",
  "X-FB-Friendly-Name": "PolarisProfilePostsTabContentQuery_connection",
  "X-CSRFToken": "csrf",
  Cookie: "sessionid=s",
  "User-Agent": "Chrome",
  Referer: "https://www.instagram.com/sample.user/",
  Origin: "https://www.instagram.com",
};
const paging = { url: "https://www.instagram.com/graphql/query", method: "POST", headers, body };

/** What the script hands `fetch`, and what it answers. */
async function run(script: string): Promise<{ url: string; init: { method: string; headers: Record<string, string>; body: string; credentials: string }; answer: unknown }> {
  let seen: { url: string; init: never } | undefined;
  const fetch = async (url: string, init: never) => {
    seen = { url, init };
    return { status: 200, text: async () => "ok" };
  };
  const answer = await vm.runInNewContext(script, { fetch });
  if (!seen) throw new Error("fetch was not called");
  return { ...seen, answer };
}

describe("the page's own posts request", () => {
  it("is the graphql POST with a cursor whose answer holds the profile's posts", () => {
    expect(postsRequest(paging, POSTS_ANSWER)).toMatchObject({ url: paging.url, body });
  });

  it("is not the first query, which has no cursor", () => {
    const first = new URLSearchParams({ variables: JSON.stringify({ data: { count: 12 }, username: "sample.user" }) }).toString();
    expect(postsRequest({ ...paging, body: first }, POSTS_ANSWER)).toBeNull();
  });

  it("is not a request answered with something else, nor a GET", () => {
    expect(postsRequest(paging, '{"data":{"xdt_api__v1__feed__timeline__connection":{}}}')).toBeNull();
    expect(postsRequest({ ...paging, method: "GET" }, POSTS_ANSWER)).toBeNull();
    expect(postsRequest({ ...paging, url: "https://www.instagram.com/ajax/bz" }, POSTS_ANSWER)).toBeNull();
  });

  it("keeps only the headers the page set itself", () => {
    expect((postsRequest(paging, POSTS_ANSWER) as PostsRequest).headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-Friendly-Name": "PolarisProfilePostsTabContentQuery_connection",
      "X-CSRFToken": "csrf",
    });
  });

  it("is sent again from after the new cursor, with the page's credentials, everything else unchanged", async () => {
    const request = postsRequest(paging, POSTS_ANSWER) as PostsRequest;
    const sent = await run(resendScript(request, "cursor-2"));
    expect(sent.url).toBe(paging.url);
    expect([sent.init.method, sent.init.credentials]).toEqual(["POST", "include"]);
    expect(sent.init.headers).toEqual(request.headers);
    const form = new URLSearchParams(sent.init.body);
    expect(JSON.parse(form.get("variables") as string)).toEqual({ ...variables, after: "cursor-2" });
    expect([form.get("fb_dtsg"), form.get("doc_id")]).toEqual(["tok:en", "9"]);
    expect(sent.answer).toEqual({ status: 200, text: "ok" });
  });

  it("can't be broken out of by quotes in what Instagram sent", async () => {
    const odd = { ...(postsRequest(paging, POSTS_ANSWER) as PostsRequest), url: 'https://www.instagram.com/graphql/query?x="); throw 1; ("' };
    const sent = await run(resendScript(odd, `c"'\`\${x}\n`));
    expect(sent.url).toBe(odd.url);
    expect(JSON.parse(new URLSearchParams(sent.init.body).get("variables") as string).after).toBe(`c"'\`\${x}\n`);
  });
});

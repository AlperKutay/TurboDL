import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { SIGNED_OUT_POSTS_QUERY, SIGNED_OUT_TRAY_QUERY } from "@turbodl/shared";
import { NO_ANSWER, OperationIds, STALE_SIGNED_OUT, STALE_SIGNED_OUT_TRAY, operationIds, signedOutQueryScript } from "../../src/main/instagram/signed-out";

/** A script that defines `name`'s operation id the way Instagram's bundles do. */
const defines = (name: string, id: string) => `__d("${name}_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="${id}"}),null);`;

/** What the script hands `fetch`, and what it answers. */
async function run(script: string, cookie = ""): Promise<{ url: string; init: { method: string; headers: Record<string, string>; body: string; credentials: string }; answer: unknown }> {
  let seen: { url: string; init: never } | undefined;
  const fetch = async (url: string, init: never) => {
    seen = { url, init };
    return { status: 200, text: async () => "ok" };
  };
  const answer = await vm.runInNewContext(script, { fetch, document: { cookie } });
  if (!seen) throw new Error("fetch was not called");
  return { ...seen, answer };
}

const query = { docId: "25773221932354322", lsd: "AVq-abc_123", name: SIGNED_OUT_POSTS_QUERY, variables: { after: "c1", first: 12, username: "sample.user", __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false } };

describe("the signed-out queries' ids", () => {
  it("are found in the scripts the page loads, and nothing else is", () => {
    const ids = new OperationIds();
    ids.note(`x;${defines(SIGNED_OUT_POSTS_QUERY, "111")}y;${defines(SIGNED_OUT_TRAY_QUERY, "222")};${defines("PolarisOtherQuery", "333")}`);
    expect([ids.get(SIGNED_OUT_POSTS_QUERY), ids.get(SIGNED_OUT_TRAY_QUERY), ids.get("PolarisOtherQuery")]).toEqual(["111", "222", undefined]);
  });

  it("keep a known id when a later script doesn't hold it, and take a newer one when it does", () => {
    const ids = new OperationIds();
    ids.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    ids.note("function nothing(){}");
    ids.note(defines(`${SIGNED_OUT_POSTS_QUERY}_connection`, "999"));
    expect(ids.get(SIGNED_OUT_POSTS_QUERY)).toBe("111");
    ids.note(defines(SIGNED_OUT_POSTS_QUERY, "444"));
    expect(ids.get(SIGNED_OUT_POSTS_QUERY)).toBe("444");
  });

  it("can be forgotten one by one", () => {
    const ids = new OperationIds();
    ids.note(defines(SIGNED_OUT_POSTS_QUERY, "111") + defines(SIGNED_OUT_TRAY_QUERY, "222"));
    ids.forget(SIGNED_OUT_POSTS_QUERY);
    expect([ids.get(SIGNED_OUT_POSTS_QUERY), ids.get(SIGNED_OUT_TRAY_QUERY)]).toEqual([undefined, "222"]);
  });

  it("forget a failed id only while it is still the one known, not one noted since", () => {
    const ids = new OperationIds();
    ids.note(defines(SIGNED_OUT_POSTS_QUERY, "222"));
    ids.forget(SIGNED_OUT_POSTS_QUERY, "111");
    expect(ids.get(SIGNED_OUT_POSTS_QUERY)).toBe("222");
    ids.forget(SIGNED_OUT_POSTS_QUERY, "222");
    expect(ids.get(SIGNED_OUT_POSTS_QUERY)).toBeUndefined();
  });

  it("want Instagram's CDN scripts scanned only while an id is missing", () => {
    const ids = new OperationIds();
    const cdn = "https://static.cdninstagram.com/rsrc.php/v4/yX/r/abc.js";
    expect(ids.missing()).toBe(true);
    expect(ids.wants(cdn, "application/javascript")).toBe(true);
    expect(ids.wants(cdn, "text/css")).toBe(false);
    expect(ids.wants("https://www.instagram.com/api/graphql", "text/javascript")).toBe(false);
    expect(ids.wants("https://cdn.example/x.js", "text/javascript")).toBe(false);
    ids.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    expect(ids.wants(cdn, "text/javascript")).toBe(true);
    ids.note(defines(SIGNED_OUT_TRAY_QUERY, "222"));
    expect([ids.missing(), ids.wants(cdn, "text/javascript")]).toEqual([false, false]);
    // a stale id opens the scripts again
    ids.forget(SIGNED_OUT_TRAY_QUERY, "222");
    expect([ids.missing(), ids.wants(cdn, "text/javascript")]).toEqual([true, true]);
  });

  it("are kept once for the app's run", () => {
    expect(operationIds).toBeInstanceOf(OperationIds);
  });
});

describe("a signed-out query sent from the page", () => {
  it("is a form POST to the page's /api/graphql, with the page's credentials and Instagram's headers", async () => {
    const sent = await run(signedOutQueryScript(query), "mid=m; csrftoken=tok123; ig_did=d");
    expect(sent.url).toBe("/api/graphql");
    expect([sent.init.method, sent.init.credentials]).toEqual(["POST", "include"]);
    expect(sent.init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-LSD": "AVq-abc_123",
      "X-IG-App-ID": "936619743392459",
      "X-CSRFToken": "tok123",
      "X-FB-Friendly-Name": SIGNED_OUT_POSTS_QUERY,
    });
    expect(sent.answer).toEqual({ status: 200, text: "ok" });
  });

  it("carries the query's id, its variables, the lsd and Relay's fields in its form", async () => {
    const form = new URLSearchParams((await run(signedOutQueryScript(query))).init.body);
    expect(Object.fromEntries(form)).toEqual({
      doc_id: "25773221932354322",
      variables: JSON.stringify(query.variables),
      lsd: "AVq-abc_123",
      fb_api_req_friendly_name: SIGNED_OUT_POSTS_QUERY,
      fb_api_caller_class: "RelayModern",
      server_timestamps: "true",
    });
    expect(JSON.parse(form.get("variables") as string)).toEqual({ after: "c1", first: 12, username: "sample.user", __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false });
  });

  it("sends an empty CSRF token when the page has none", async () => {
    expect((await run(signedOutQueryScript(query), "mid=m")).init.headers["X-CSRFToken"]).toBe("");
  });

  it("can't be broken out of by quotes in what Instagram sent", async () => {
    const odd = `c"'\`\${x}\n</script>`;
    const sent = await run(signedOutQueryScript({ ...query, lsd: odd, variables: { after: odd } }));
    expect(sent.init.headers["X-FB-LSD"]).toBe(odd);
    const form = new URLSearchParams(sent.init.body);
    expect([form.get("lsd"), JSON.parse(form.get("variables") as string).after]).toEqual([odd, odd]);
  });
});

describe("a failed signed-out query", () => {
  it("says Instagram changed its page when the query is stale, and that Instagram didn't answer when it got nothing", () => {
    expect(STALE_SIGNED_OUT).toBe("Instagram changed its signed-out profile page; TurboDL couldn't read further posts.");
    expect(STALE_SIGNED_OUT_TRAY).toBe("Instagram changed its signed-out profile page; TurboDL couldn't read further highlights.");
    expect(NO_ANSWER).toBe("Instagram didn't answer.");
  });
});

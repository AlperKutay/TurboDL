import { afterEach, describe, expect, it } from "vitest";
import { SavedError, type BrowserCookie } from "@turbodl/shared";
import { SavedClient, httpGet, type HttpGet } from "../../src/main/instagram/saved-client";
import { startTestServer, type TestServer } from "../fixtures/test-server";

const cookie = (name: string, value: string, expires = 0): BrowserCookie => ({ domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires, name, value });
const jar = [cookie("csrftoken", "tok"), cookie("sessionid", "s"), cookie("old", "x", 1000)];
const lastPage = JSON.stringify({ items: [], more_available: false, status: "ok" });

function fakeGet(answer: { status: number; body: string } = { status: 200, body: lastPage }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const get: HttpGet = async (url, headers) => {
    calls.push({ url, headers });
    return answer;
  };
  return { get, calls };
}

async function failure(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (err) {
    if (err instanceof SavedError) return err.kind;
    throw err;
  }
  return undefined;
}

describe("SavedClient", () => {
  it("asks All and a collection at their feed addresses", async () => {
    const { get, calls } = fakeGet();
    const client = new SavedClient(() => jar, "Agent/1", get);
    await client.page({ kind: "all" });
    await client.page({ kind: "collection", id: "102" });
    expect(calls.map((c) => c.url)).toEqual(["https://www.instagram.com/api/v1/feed/saved/posts/", "https://www.instagram.com/api/v1/feed/collection/102/posts/"]);
  });

  it("percent-encodes everything but letters and digits in the cursor, as the iPhone does", async () => {
    const { get, calls } = fakeGet();
    await new SavedClient(() => jar, "Agent/1", get).page({ kind: "all" }, "a b/c=d-e_f.g");
    expect(calls[0].url).toBe("https://www.instagram.com/api/v1/feed/saved/posts/?max_id=a%20b%2Fc%3Dd%2De%5Ff%2Eg");
  });

  it("sends exactly the web client's headers, with the unexpired cookies", async () => {
    const { get, calls } = fakeGet();
    await new SavedClient(() => jar, "Agent/1", get).page({ kind: "all" });
    expect(calls[0].headers).toEqual({
      Cookie: "csrftoken=tok; sessionid=s",
      "X-IG-App-ID": "936619743392459",
      "X-CSRFToken": "tok",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.instagram.com/",
      "User-Agent": "Agent/1",
    });
  });

  it("asks nothing without a live session", async () => {
    const { get, calls } = fakeGet();
    expect(await failure(new SavedClient(() => [cookie("csrftoken", "tok")], "Agent/1", get).page({ kind: "all" }))).toBe("signedOut");
    expect(await failure(new SavedClient(() => [cookie("sessionid", "s", 1000)], "Agent/1", get).username())).toBe("signedOut");
    expect(calls).toHaveLength(0);
  });

  it("reads the username from the edit-profile form", async () => {
    const { get, calls } = fakeGet({ status: 200, body: JSON.stringify({ form_data: { username: "sample.user" }, status: "ok" }) });
    expect(await new SavedClient(() => jar, "Agent/1", get).username()).toBe("sample.user");
    expect(calls[0].url).toBe("https://www.instagram.com/api/v1/accounts/edit/web_form_data/");
  });

  it("passes Instagram's push-back on", async () => {
    const { get } = fakeGet({ status: 429, body: "" });
    expect(await failure(new SavedClient(() => jar, "Agent/1", get).page({ kind: "all" }))).toBe("rateLimited");
  });
});

describe("httpGet", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("answers the status and the body, with the headers it was given", async () => {
    server = await startTestServer();
    server.setFile("/api", { data: Buffer.from('{"status":"ok"}'), contentType: "application/json" });
    expect(await httpGet(server.url("/api"), { "X-IG-App-ID": "1" })).toEqual({ status: 200, body: '{"status":"ok"}' });
    expect(server.requests[0].headers["x-ig-app-id"]).toBe("1");
    expect((await httpGet(server.url("/missing"), {})).status).toBe(404);
  });
});

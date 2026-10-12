import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError, request } from "../../src/main/engine/http";
import { probe } from "../../src/main/engine/probe";
import { startTestServer, type TestServer } from "../fixtures/test-server";

let server: TestServer;
beforeEach(async () => {
  server = await startTestServer();
});
afterEach(async () => {
  await server.close();
});

describe("probe", () => {
  it("detects size and range support", async () => {
    server.setFile("/files/a.bin", { data: Buffer.alloc(5000, 1), etag: '"v1"', contentType: "application/zip" });
    const info = await probe(server.url("/files/a.bin"), {});
    expect(info).toMatchObject({ size: 5000, resumable: true, filename: "a.bin", mime: "application/zip", etag: '"v1"' });
    expect(server.requests[0].range).toBe("bytes=0-0");
  });

  it("handles servers without range support", async () => {
    server.setFile("/nr.bin", { data: Buffer.alloc(3000), ranges: false });
    const info = await probe(server.url("/nr.bin"), {});
    expect(info.resumable).toBe(false);
    expect(info.size).toBe(3000);
  });

  it("reports an unknown size for chunked responses", async () => {
    server.setFile("/chunked", { data: Buffer.alloc(3000), ranges: false, omitLength: true });
    const info = await probe(server.url("/chunked"), {});
    expect(info.size).toBeNull();
    expect(info.resumable).toBe(false);
  });

  it("uses Content-Disposition for the name", async () => {
    server.setFile("/get", { data: Buffer.alloc(10), contentDisposition: "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.zip" });
    expect((await probe(server.url("/get"), {})).filename).toBe("résumé.zip");
  });

  it("follows redirects", async () => {
    server.setFile("/final/f.zip", { data: Buffer.alloc(10) });
    server.setFile("/go", { data: Buffer.alloc(0), redirectTo: "/final/f.zip" });
    const info = await probe(server.url("/go"), {});
    expect(info.finalUrl).toBe(server.url("/final/f.zip"));
    expect(info.filename).toBe("f.zip");
  });

  it("treats an empty file as size 0", async () => {
    server.setFile("/empty", { data: Buffer.alloc(0) });
    const info = await probe(server.url("/empty"), {});
    expect(info.size).toBe(0);
    expect(info.resumable).toBe(false);
  });

  it("throws HttpError for 4xx", async () => {
    server.setFile("/gone", { data: Buffer.alloc(0), status: 404 });
    await expect(probe(server.url("/gone"), {})).rejects.toMatchObject({ name: "HttpError", status: 404 });
  });
});

describe("request", () => {
  it("sends identity encoding and caller headers", async () => {
    server.setFile("/h", { data: Buffer.alloc(10) });
    const res = await request(server.url("/h"), { headers: { Referer: "https://site.example/", Cookie: "a=1" } });
    res.body.resume();
    const h = server.requests[0].headers;
    expect(h["accept-encoding"]).toBe("identity");
    expect(h.referer).toBe("https://site.example/");
    expect(h.cookie).toBe("a=1");
    expect(h["user-agent"]).toContain("Mozilla/5.0");
  });

  it("drops cookies on a cross-host redirect", async () => {
    server.setFile("/target", { data: Buffer.alloc(10) });
    const crossHost = server.url("/target").replace("127.0.0.1", "localhost");
    server.setFile("/jump", { data: Buffer.alloc(0), redirectTo: crossHost });
    const res = await request(server.url("/jump"), { headers: { Cookie: "secret=1" } });
    res.body.resume();
    expect(server.requests[0].headers.cookie).toBe("secret=1");
    expect(server.requests[1].headers.cookie).toBeUndefined();
  });

  it("rejects with an AbortError when aborted", async () => {
    server.setFile("/slow", { data: Buffer.alloc(100_000), throttle: 1000 });
    const controller = new AbortController();
    const res = await request(server.url("/slow"), { signal: controller.signal });
    const reading = (async () => {
      for await (const _ of res.body) {
        // consume
      }
    })();
    controller.abort();
    await expect(reading).rejects.toBeTruthy();
  });

  it("exports HttpError with a readable message", () => {
    expect(new HttpError(403).message).toContain("403");
  });
});

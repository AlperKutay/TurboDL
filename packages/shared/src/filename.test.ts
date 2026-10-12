import { describe, expect, it } from "vitest";
import { filenameFromUrl, parseContentDisposition, sanitizeFilename, splitExt, uniqueName } from "./index";

describe("parseContentDisposition", () => {
  it("reads quoted and bare filenames", () => {
    expect(parseContentDisposition('attachment; filename="report.pdf"')).toBe("report.pdf");
    expect(parseContentDisposition("attachment; filename=plain.zip")).toBe("plain.zip");
    expect(parseContentDisposition('attachment; filename="a \\"b\\".txt"')).toBe('a "b".txt');
  });

  it("prefers RFC 5987 filename*", () => {
    expect(parseContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.zip")).toBe("résumé final.zip");
    expect(parseContentDisposition("attachment; filename=\"fallback.zip\"; filename*=UTF-8''na%C3%AFve.zip")).toBe("naïve.zip");
  });

  it("repairs raw UTF-8 bytes that arrived as latin1", () => {
    expect(parseContentDisposition('attachment; filename="caf\u00c3\u00a9.zip"')).toBe("café.zip");
  });

  it("returns null when there is no filename", () => {
    expect(parseContentDisposition(undefined)).toBeNull();
    expect(parseContentDisposition("inline")).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("replaces characters that are illegal on Windows", () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j.txt')).toBe("a_b_c_d_e_f_g_h_i_j.txt");
  });

  it("handles reserved names, trailing dots and empty input", () => {
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFilename("  name. . ")).toBe("name");
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("a\u0001b.zip")).toBe("ab.zip");
  });

  it("limits the length but keeps the extension", () => {
    const out = sanitizeFilename(`${"x".repeat(300)}.zip`);
    expect(out.length).toBe(200);
    expect(out.endsWith(".zip")).toBe(true);
  });

  it("keeps non-ASCII characters", () => {
    expect(sanitizeFilename("Résumé Ærø.pdf")).toBe("Résumé Ærø.pdf");
  });
});

describe("filenameFromUrl", () => {
  it("decodes the last path segment", () => {
    expect(filenameFromUrl("https://x.com/dir/My%20File.zip?x=1")).toBe("My File.zip");
  });

  it("returns null without a usable segment", () => {
    expect(filenameFromUrl("https://x.com/")).toBeNull();
    expect(filenameFromUrl("not a url")).toBeNull();
  });
});

describe("uniqueName / splitExt", () => {
  it("adds a counter before the extension", () => {
    const taken = new Set(["a.zip", "a (1).zip"]);
    expect(uniqueName("a.zip", (n) => taken.has(n))).toBe("a (2).zip");
    expect(uniqueName("free.zip", (n) => taken.has(n))).toBe("free.zip");
    expect(uniqueName("noext", (n) => n === "noext")).toBe("noext (1)");
  });

  it("splits the extension with its dot", () => {
    expect(splitExt("a.b.zip")).toEqual(["a.b", ".zip"]);
    expect(splitExt(".hidden")).toEqual([".hidden", ""]);
  });
});

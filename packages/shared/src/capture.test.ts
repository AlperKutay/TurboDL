import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_EXTENSIONS, captureDecision, type CapturePolicy } from "./index";

const policy: CapturePolicy = { enabled: true, extensions: DEFAULT_CAPTURE_EXTENSIONS, minSize: 0, selfExtensionId: "self" };

describe("captureDecision", () => {
  it("captures listed extensions from the URL", () => {
    expect(captureDecision({ url: "https://x.com/a.zip" }, policy)).toBe("capture");
    expect(captureDecision({ url: "https://x.com/SETUP.EXE" }, policy)).toBe("capture");
  });

  it("skips when disabled, self-initiated or not http(s)", () => {
    expect(captureDecision({ url: "https://x.com/a.zip" }, { ...policy, enabled: false })).toBe("skip");
    expect(captureDecision({ url: "https://x.com/a.zip", byExtensionId: "self" }, policy)).toBe("skip");
    expect(captureDecision({ url: "blob:https://x.com/123" }, policy)).toBe("skip");
    expect(captureDecision({ url: "data:application/zip;base64,AA==" }, policy)).toBe("skip");
  });

  it("trusts a known filename over the URL", () => {
    expect(captureDecision({ url: "https://x.com/get.php?id=1", filename: "film.mkv" }, policy)).toBe("capture");
    expect(captureDecision({ url: "https://x.com/a.zip", filename: "page.html" }, policy)).toBe("skip");
  });

  it("uses the MIME type when name and URL give no hint", () => {
    expect(captureDecision({ url: "https://x.com/get", mime: "application/pdf" }, policy)).toBe("capture");
  });

  it("is undecided while the filename is unknown and nothing matches", () => {
    expect(captureDecision({ url: "https://x.com/get.php?id=1", mime: "application/octet-stream" }, policy)).toBe("undecided");
    expect(captureDecision({ url: "https://x.com/get.php?id=1", filename: "get.php" }, policy)).toBe("skip");
  });

  it("respects the minimum size only when the size is known", () => {
    const strict = { ...policy, minSize: 1024 * 1024 };
    expect(captureDecision({ url: "https://x.com/a.zip", fileSize: 1000 }, strict)).toBe("skip");
    expect(captureDecision({ url: "https://x.com/a.zip", fileSize: 0 }, strict)).toBe("capture");
    expect(captureDecision({ url: "https://x.com/a.zip" }, strict)).toBe("capture");
  });
});

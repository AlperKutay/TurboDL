import { describe, expect, it } from "vitest";
import { parseRoute } from "./route";

describe("parseRoute", () => {
  it("recognises dialog routes", () => {
    expect(parseRoute("#/new/abc123")).toEqual({ view: "new", id: "abc123" });
    expect(parseRoute("#/media/x%20y")).toEqual({ view: "media", id: "x y" });
  });

  it("falls back to the main window", () => {
    expect(parseRoute("")).toEqual({ view: "main" });
    expect(parseRoute("#/")).toEqual({ view: "main" });
    expect(parseRoute("#/new/")).toEqual({ view: "main" });
  });
});

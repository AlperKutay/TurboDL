import { describe, expect, it } from "vitest";
import type { MediaFormatOption } from "@turbodl/shared";
import { pickFormat } from "../../src/main/media/new-download";
import { AUDIO_ONLY, SINGLE_OPTION } from "../../src/main/media/quality";

const opt = (height: number): MediaFormatOption => ({ id: `h${height}`, label: `${height}p`, formatSelector: `sel${height}`, audioOnly: false, height });
const ladder = [opt(1080), opt(720), opt(480), AUDIO_ONLY];

describe("pickFormat", () => {
  it("takes the best quality by default", () => {
    expect(pickFormat(ladder, {})?.option.id).toBe("h1080");
  });

  it("takes the highest quality not above maxHeight", () => {
    expect(pickFormat(ladder, { maxHeight: 720 })).toEqual({ option: ladder[1] });
  });

  it("takes the lowest one with a warning when none is low enough", () => {
    expect(pickFormat(ladder, { maxHeight: 360 })).toEqual({ option: ladder[2], warning: "No quality at or below 360p; taking 480p." });
  });

  it("takes the audio option for audio", () => {
    expect(pickFormat(ladder, { audio: true })?.option).toBe(AUDIO_ONLY);
  });

  it("is null for audio when there is no audio option", () => {
    expect(pickFormat([opt(720)], { audio: true })).toBeNull();
  });

  it("is null when there is only audio", () => {
    expect(pickFormat([AUDIO_ONLY], {})).toBeNull();
  });

  it("takes a heightless option by default", () => {
    expect(pickFormat([SINGLE_OPTION], {})?.option).toBe(SINGLE_OPTION);
  });
});

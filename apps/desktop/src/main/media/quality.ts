import type { MediaFormatOption } from "@turbodl/shared";

/** The "audio only" choice of a stream; converted to mp3 after download. */
export const AUDIO_ONLY: MediaFormatOption = { id: "audio", label: "Audio only (MP3)", formatSelector: "audio", audioOnly: true };

/** The only quality of a media playlist that has no variants. */
export const SINGLE_OPTION: MediaFormatOption = { id: "media", label: "Stream quality", formatSelector: "media", audioOnly: false };

export function mbps(bandwidth: number): string {
  return `${(bandwidth / 1e6).toFixed(1)} Mbps`;
}

export function qualityLabel(height: number | null, frameRate: number | null, bandwidth: number): string {
  if (height === null) return mbps(bandwidth);
  const fps = frameRate !== null && frameRate > 30 ? String(Math.round(frameRate)) : "";
  return `${height}p${fps} · ${mbps(bandwidth)}`;
}

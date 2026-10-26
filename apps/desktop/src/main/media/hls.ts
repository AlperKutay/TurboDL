import type { MediaFormatOption } from "@turbodl/shared";
import type { Fragment, FragmentKey, FragmentPlan } from "../engine/fragments";
import { AUDIO_ONLY, qualityLabel } from "./quality";

export interface HlsVariant {
  url: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  codecs: string;
  audioGroup: string | null;
}

export interface HlsAudio {
  groupId: string;
  name: string;
  url: string | null;
  isDefault: boolean;
}

export interface HlsMaster {
  variants: HlsVariant[];
  audio: HlsAudio[];
}

export interface HlsMedia {
  plan: FragmentPlan;
  /** no #EXT-X-ENDLIST: a live stream */
  live: boolean;
  /** SAMPLE-AES or a vendor key format */
  drm: boolean;
  /** has an init map (fragmented mp4) */
  fmp4: boolean;
  duration: number;
}

export type HlsPlaylist = { type: "master"; master: HlsMaster } | { type: "media"; media: HlsMedia };

export function parseAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

const tagValue = (line: string) => line.slice(line.indexOf(":") + 1);
const absolute = (ref: string, base: string) => new URL(ref, base).toString();

function num(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseByteRange(text: string): { length: number; offset: number | null } {
  const [length, offset] = text.split("@");
  return { length: Number(length), offset: offset === undefined ? null : Number(offset) };
}

function parseIv(text: string | undefined): Buffer | null {
  if (!text) return null;
  const hex = text.replace(/^0x/i, "").padStart(32, "0");
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}

export function parseHls(text: string, url: string): HlsPlaylist {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) return { type: "master", master: parseMaster(lines, url) };
  return { type: "media", media: parseMedia(lines, url) };
}

function parseMaster(lines: string[], url: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const audio: HlsAudio[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttributes(tagValue(line));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith("#")) j++;
      if (j >= lines.length) break;
      const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION ?? "");
      variants.push({
        url: absolute(lines[j], url),
        bandwidth: num(a.BANDWIDTH) ?? 0,
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        frameRate: num(a["FRAME-RATE"]),
        codecs: a.CODECS ?? "",
        audioGroup: a.AUDIO ?? null,
      });
      i = j;
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(tagValue(line));
      if (a.TYPE !== "AUDIO") continue;
      audio.push({ groupId: a["GROUP-ID"] ?? "", name: a.NAME ?? "", url: a.URI ? absolute(a.URI, url) : null, isDefault: a.DEFAULT === "YES" });
    }
  }
  return { variants, audio };
}

function parseMedia(lines: string[], url: string): HlsMedia {
  const fragments: Fragment[] = [];
  let init: Fragment | undefined;
  let currentMap: string | null = null;
  let key: FragmentKey | undefined;
  let drm = false;
  let live = true;
  let sequence = 0;
  let duration = 0;
  let pendingRange: { length: number; offset: number | null } | null = null;
  const rangeEnds = new Map<string, number>();

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number(tagValue(line)) || 0;
    else if (line.startsWith("#EXTINF:")) duration += parseFloat(tagValue(line)) || 0;
    else if (line.startsWith("#EXT-X-BYTERANGE:")) pendingRange = parseByteRange(tagValue(line));
    else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(tagValue(line));
      const method = (a.METHOD ?? "NONE").toUpperCase();
      if (method === "NONE") key = undefined;
      else if (method === "AES-128" && (!a.KEYFORMAT || a.KEYFORMAT === "identity") && a.URI) key = { url: absolute(a.URI, url), iv: parseIv(a.IV) };
      else drm = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(tagValue(line));
      if (!a.URI) continue;
      const mapUrl = absolute(a.URI, url);
      const range = a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null;
      const fragment: Fragment = { url: mapUrl, sequence: 0 };
      if (range) fragment.range = { start: range.offset ?? 0, end: (range.offset ?? 0) + range.length - 1 };
      const id = `${mapUrl}#${a.BYTERANGE ?? ""}`;
      if (!init) init = fragment;
      else if (id !== currentMap) fragments.push(fragment);
      currentMap = id;
    } else if (line === "#EXT-X-ENDLIST") live = false;
    else if (!line.startsWith("#")) {
      const fragmentUrl = absolute(line, url);
      const fragment: Fragment = { url: fragmentUrl, sequence };
      if (key) fragment.key = key;
      if (pendingRange) {
        const start = pendingRange.offset ?? rangeEnds.get(fragmentUrl) ?? 0;
        fragment.range = { start, end: start + pendingRange.length - 1 };
        rangeEnds.set(fragmentUrl, start + pendingRange.length);
        pendingRange = null;
      }
      fragments.push(fragment);
      sequence++;
    }
  }
  const plan: FragmentPlan = { fragments };
  if (init) plan.init = init;
  return { plan, live, drm, fmp4: Boolean(init), duration };
}

const DOLBY = /(ac-3|ec-3)/i;

/** true when `a` is the better download of the two (AAC/unspecified audio first, then bandwidth). */
function better(a: HlsVariant, b: HlsVariant): boolean {
  const aac = Number(!DOLBY.test(a.codecs)) - Number(!DOLBY.test(b.codecs));
  return aac !== 0 ? aac > 0 : a.bandwidth > b.bandwidth;
}

export function variantKey(v: HlsVariant): string {
  return v.height !== null ? `${v.width}x${v.height}@${v.bandwidth}` : `@${v.bandwidth}`;
}

export function hlsOptions(master: HlsMaster): MediaFormatOption[] {
  const best = new Map<string, HlsVariant>();
  for (const v of master.variants) {
    const group = v.height !== null ? `h${v.height}` : variantKey(v);
    const current = best.get(group);
    if (!current || better(v, current)) best.set(group, v);
  }
  const chosen = [...best.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);
  return [
    ...chosen.map((v) => {
      const key = variantKey(v);
      return { id: key, label: qualityLabel(v.height, v.frameRate, v.bandwidth), formatSelector: key, audioOnly: false, ...(v.height !== null ? { height: v.height } : {}) };
    }),
    AUDIO_ONLY,
  ];
}

export function bestVariant(master: HlsMaster): HlsVariant | null {
  let best: HlsVariant | null = null;
  for (const v of master.variants) {
    if (!best || (v.height ?? 0) > (best.height ?? 0) || ((v.height ?? 0) === (best.height ?? 0) && better(v, best))) best = v;
  }
  return best;
}

export function lowestVariant(master: HlsMaster): HlsVariant | null {
  return master.variants.reduce<HlsVariant | null>((low, v) => (!low || v.bandwidth < low.bandwidth ? v : low), null);
}

/** The variant with this key; if the playlist changed, the closest bandwidth at the same height. */
export function pickVariant(master: HlsMaster, key: string): HlsVariant | null {
  const exact = master.variants.find((v) => variantKey(v) === key);
  if (exact) return exact;
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(key);
  if (!m) return null;
  const height = Number(m[2]);
  const bandwidth = Number(m[3]);
  const same = master.variants.filter((v) => v.height === height);
  if (same.length === 0) return null;
  return same.reduce((a, b) => (Math.abs(b.bandwidth - bandwidth) < Math.abs(a.bandwidth - bandwidth) ? b : a));
}

/** The variant's separate audio playlist (DEFAULT=YES first), or null when the audio is inside the variant. */
export function audioFor(master: HlsMaster, v: HlsVariant): HlsAudio | null {
  if (!v.audioGroup) return null;
  const group = master.audio.filter((a) => a.groupId === v.audioGroup && a.url);
  return group.find((a) => a.isDefault) ?? group[0] ?? null;
}

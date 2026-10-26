import { XMLParser } from "fast-xml-parser";
import type { MediaFormatOption } from "@turbodl/shared";
import type { Fragment, FragmentPlan } from "../engine/fragments";
import { AUDIO_ONLY, qualityLabel } from "./quality";

export interface DashRepresentation {
  id: string;
  kind: "video" | "audio" | "other";
  bandwidth: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  codecs: string;
  mimeType: string;
  protected: boolean;
  /** null: addressing TurboDL does not handle */
  source: { kind: "file"; url: string } | { kind: "fragments"; plan: FragmentPlan } | null;
}

export interface DashManifest {
  live: boolean;
  multiPeriod: boolean;
  duration: number | null;
  representations: DashRepresentation[];
}

type Node = Record<string, any>;
const ARRAYS = new Set(["Period", "AdaptationSet", "Representation", "S", "SegmentURL", "BaseURL", "ContentProtection"]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ARRAYS.has(name),
});

const el = (x: unknown): Node => (x && typeof x === "object" ? (x as Node) : {});
const list = (x: unknown): Node[] => (Array.isArray(x) ? x.map(el) : x === undefined ? [] : [el(x)]);

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function frameRate(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const [a, b] = v.split("/").map(Number);
  const rate = b ? a / b : a;
  return Number.isFinite(rate) ? rate : null;
}

export function parseIsoDuration(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text.trim());
  if (!m || text.trim() === "P" || text.trim() === "PT") return null;
  const [d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

export function expandTemplate(template: string, vars: { RepresentationID: string; Bandwidth: number; Number?: number; Time?: number }): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (whole, name: string, width: string | undefined) => {
    if (name === "") return "$";
    const value = (vars as Record<string, string | number | undefined>)[name];
    if (value === undefined) return whole;
    const text = String(value);
    return width && typeof value === "number" ? text.padStart(Number(width), "0") : text;
  });
}

function baseUrlOf(node: Node): string | null {
  const raw: unknown = Array.isArray(node.BaseURL) ? node.BaseURL[0] : node.BaseURL;
  const text = typeof raw === "string" ? raw : typeof el(raw)["#text"] === "string" ? el(raw)["#text"] : null;
  return text && text.trim() ? text.trim() : null;
}

function withBase(base: string, node: Node): string {
  const ref = baseUrlOf(node);
  return ref ? new URL(ref, base).toString() : base;
}

function kindOf(contentType: string, mimeType: string, codecs: string): DashRepresentation["kind"] {
  if (contentType === "video" || mimeType.startsWith("video/")) return "video";
  if (contentType === "audio" || mimeType.startsWith("audio/")) return "audio";
  if (/^(avc|hev|hvc|vp0?9|av01|vp8)/i.test(codecs)) return "video";
  if (/^(mp4a|opus|vorbis|ac-3|ec-3|flac)/i.test(codecs)) return "audio";
  return "other";
}

function byteRange(text: string): { start: number; end: number } {
  const [start, end] = text.split("-").map(Number);
  return { start, end };
}

function sourceOf(set: Node, rep: Node, base: string, id: string, bandwidth: number, duration: number | null): DashRepresentation["source"] {
  const vars = { RepresentationID: id, Bandwidth: bandwidth };
  const setTemplate = set.SegmentTemplate === undefined ? null : el(set.SegmentTemplate);
  const repTemplate = rep.SegmentTemplate === undefined ? null : el(rep.SegmentTemplate);
  if (setTemplate || repTemplate) {
    const tpl: Node = { ...(setTemplate ?? {}), ...(repTemplate ?? {}) };
    const media = tpl["@media"];
    if (typeof media !== "string") return null;
    const timescale = Number(tpl["@timescale"] ?? 1);
    const startNumber = Number(tpl["@startNumber"] ?? 1);
    const fragments: Fragment[] = [];
    const add = (n: number, t: number) => fragments.push({ url: new URL(expandTemplate(media, { ...vars, Number: n, Time: t }), base).toString(), sequence: n });
    const steps = list(el(tpl.SegmentTimeline).S);
    if (steps.length > 0) {
      let t = 0;
      let n = startNumber;
      for (const s of steps) {
        if (s["@t"] !== undefined) t = Number(s["@t"]);
        const d = Number(s["@d"]);
        let r = Number(s["@r"] ?? 0);
        if (!(d > 0)) return null;
        if (r < 0) {
          if (duration === null) return null;
          r = Math.ceil((duration * timescale - t) / d) - 1;
        }
        for (let k = 0; k <= r; k++) {
          add(n++, t);
          t += d;
        }
      }
    } else {
      const d = Number(tpl["@duration"]);
      if (!(d > 0) || duration === null) return null;
      const count = Math.ceil((duration * timescale) / d);
      for (let i = 0; i < count; i++) add(startNumber + i, i * d);
    }
    const plan: FragmentPlan = { fragments };
    if (typeof tpl["@initialization"] === "string") plan.init = { url: new URL(expandTemplate(tpl["@initialization"], vars), base).toString(), sequence: 0 };
    return { kind: "fragments", plan };
  }
  const segmentList = rep.SegmentList ?? set.SegmentList;
  if (segmentList !== undefined) {
    const sl = el(segmentList);
    const fragments: Fragment[] = list(sl.SegmentURL).map((s, i) => {
      const fragment: Fragment = { url: s["@media"] ? new URL(s["@media"], base).toString() : base, sequence: i };
      if (s["@mediaRange"]) fragment.range = byteRange(s["@mediaRange"]);
      return fragment;
    });
    const plan: FragmentPlan = { fragments };
    const init = el(sl.Initialization);
    if (init["@sourceURL"] || init["@range"]) {
      plan.init = { url: init["@sourceURL"] ? new URL(init["@sourceURL"], base).toString() : base, sequence: 0 };
      if (init["@range"]) plan.init.range = byteRange(init["@range"]);
    }
    return { kind: "fragments", plan };
  }
  return { kind: "file", url: base };
}

export function parseMpd(xml: string, url: string): DashManifest {
  const mpd = el(parser.parse(xml).MPD);
  const periods = list(mpd.Period);
  const period = periods[0] ?? {};
  const duration = parseIsoDuration(period["@duration"]) ?? parseIsoDuration(mpd["@mediaPresentationDuration"]);
  const periodBase = withBase(withBase(url, mpd), period);
  const representations: DashRepresentation[] = [];
  for (const set of list(period.AdaptationSet)) {
    const setBase = withBase(periodBase, set);
    for (const rep of list(set.Representation)) {
      const id = String(rep["@id"] ?? "");
      const bandwidth = Number(rep["@bandwidth"] ?? 0);
      const mimeType = String(rep["@mimeType"] ?? set["@mimeType"] ?? "");
      const codecs = String(rep["@codecs"] ?? set["@codecs"] ?? "");
      representations.push({
        id,
        kind: kindOf(String(set["@contentType"] ?? rep["@contentType"] ?? ""), mimeType, codecs),
        bandwidth,
        width: numOrNull(rep["@width"] ?? set["@width"]),
        height: numOrNull(rep["@height"] ?? set["@height"]),
        frameRate: frameRate(rep["@frameRate"] ?? set["@frameRate"]),
        codecs,
        mimeType,
        protected: list(set.ContentProtection).length > 0 || list(rep.ContentProtection).length > 0,
        source: sourceOf(set, rep, withBase(setBase, rep), id, bandwidth, duration),
      });
    }
  }
  return { live: mpd["@type"] === "dynamic", multiPeriod: periods.length > 1, duration, representations };
}

const isMp4 = (r: DashRepresentation) => Number(r.mimeType.endsWith("/mp4"));

export function dashOptions(m: DashManifest): MediaFormatOption[] {
  const best = new Map<string, DashRepresentation>();
  for (const r of m.representations) {
    if (r.kind !== "video") continue;
    const group = r.height !== null ? `h${r.height}` : `id:${r.id}`;
    const current = best.get(group);
    if (!current || isMp4(r) > isMp4(current) || (isMp4(r) === isMp4(current) && r.bandwidth > current.bandwidth)) best.set(group, r);
  }
  const options: MediaFormatOption[] = [...best.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)
    .map((r) => ({ id: r.id, label: qualityLabel(r.height, r.frameRate, r.bandwidth), formatSelector: r.id, audioOnly: false, ...(r.height !== null ? { height: r.height } : {}) }));
  if (m.representations.some((r) => r.kind === "audio")) options.push(AUDIO_ONLY);
  return options;
}

export function bestAudio(m: DashManifest): DashRepresentation | null {
  const rank = (r: DashRepresentation) => [Number(/mp4a/i.test(r.codecs)), isMp4(r), r.bandwidth];
  const audio = m.representations.filter((r) => r.kind === "audio");
  audio.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return audio[0] ?? null;
}

/** Searching Instagram's JSON for objects of a known shape, wherever its pages happen to nest them. */

export type Json = Record<string, unknown>;

/**
 * Plain JSON, or what Instagram sends instead: a `for (;;);` / `while(1);` guard in front, or several JSON values,
 * one per line (its route data). Several values come back as an array; null when nothing parses.
 */
export function parseDocument(text: string): unknown {
  const value = (body: string): unknown => {
    let rest = body.trimStart();
    for (const guard of ["for (;;);", "while(1);"]) if (rest.startsWith(guard)) rest = rest.slice(guard.length);
    try {
      return JSON.parse(rest, keepLongIds as (this: unknown, key: string, value: unknown) => unknown);
    } catch {
      return undefined;
    }
  };
  const whole = value(text);
  if (whole !== undefined) return whole;
  const lines = text
    .split(/\r?\n/)
    .map(value)
    .filter((v) => v !== undefined);
  return lines.length > 0 ? lines : null;
}

/**
 * Instagram's ids (`pk`) are 64-bit and past what a double holds: such a number is kept as its own digits, from the
 * text JSON.parse read it from (its `context.source`).
 */
function keepLongIds(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) return context.source;
  return value;
}

/** Every object `match` accepts, depth-first: roots and arrays in order, an object's keys sorted. */
export function objectsIn(roots: unknown[], match: (o: Json) => boolean): Json[] {
  const found: Json[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isJson(value)) {
      if (match(value)) found.push(value);
      for (const key of Object.keys(value).sort()) visit(value[key]);
    }
  };
  roots.forEach(visit);
  return found;
}

/** The same, in page documents (each parsed with `parseDocument`). */
export function objectsInDocuments(documents: string[], match: (o: Json) => boolean): Json[] {
  return objectsIn(
    documents.map(parseDocument).filter((d) => d !== null),
    match,
  );
}

export function isJson(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string, or a whole number as one (Instagram sends ids both ways). */
export function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function int(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
}

/** The object at `path` under `v`, if each step is one. */
export function dict(v: unknown, ...path: string[]): Json | undefined {
  let current: unknown = v;
  for (const key of path) current = isJson(current) ? current[key] : undefined;
  return isJson(current) ? current : undefined;
}

/** The objects in an array (anything else in it left out). */
export function arr(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter(isJson) : [];
}

/** An http(s) address. */
export function url(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return /^https?:\/\//i.test(v) ? v : undefined;
}

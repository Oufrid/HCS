// Deterministic anchor verification: hashing, relocation and staleness. No LLM involved.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Anchor, Claim, HcsDocument, Probe } from "./format.js";

export const HASH_LENGTH = 12;

export type AnchorStatus = "ok" | "moved" | "stale" | "missing" | "unsealed";

export interface AnchorReport {
  anchor: Anchor;
  status: AnchorStatus;
  /** Where the anchored text was found when status is "moved". */
  relocated?: { start: number; end: number };
  detail?: string;
}

export interface ItemReport {
  kind: "claim" | "probe";
  id: string;
  status: AnchorStatus;
  anchors: AnchorReport[];
}

/** Normalization makes hashes stable across CRLF/LF and trailing whitespace. */
export function normalizeLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

export function hashLines(lines: string[]): string {
  return hashText(lines.join("\n"));
}

/** Directory against which anchor paths are resolved. */
export function rootDir(doc: HcsDocument, hcsPath: string): string {
  return resolve(dirname(resolve(hcsPath)), doc.headers.root || ".");
}

export class SourceCache {
  private files = new Map<string, string[] | null>();
  constructor(public root: string) {}

  lines(path: string): string[] | null {
    if (!this.files.has(path)) {
      const full = resolve(this.root, path);
      if (!existsSync(full) || !statSync(full).isFile()) this.files.set(path, null);
      else this.files.set(path, normalizeLines(readFileSync(full, "utf8")));
    }
    return this.files.get(path)!;
  }

  /** Text covered by an anchor, or null when the file or range does not exist. */
  slice(a: Anchor): string[] | null {
    const lines = this.lines(a.path);
    if (!lines) return null;
    if (a.start === undefined) return lines;
    const end = a.end ?? a.start;
    if (end > lines.length) return null;
    return lines.slice(a.start - 1, end);
  }
}

/** Compute the hash an anchor should carry right now (null if the target does not exist). */
export function currentHash(a: Anchor, cache: SourceCache): string | null {
  const s = cache.slice(a);
  return s ? hashLines(s) : null;
}

export function checkAnchor(a: Anchor, cache: SourceCache): AnchorReport {
  const lines = cache.lines(a.path);
  if (!lines) return { anchor: a, status: "missing", detail: "file not found" };
  if (!a.hash) return { anchor: a, status: "unsealed", detail: "anchor has no hash; run `hcs seal`" };

  const slice = cache.slice(a);
  if (slice && hashLines(slice) === a.hash) return { anchor: a, status: "ok" };
  if (a.start === undefined) return { anchor: a, status: "stale", detail: "file content changed" };

  // Same-length window search: the anchored text may only have shifted.
  const len = (a.end ?? a.start) - a.start + 1;
  const found = findWindow(lines, len, a.hash, a.start - 1);
  if (found !== -1) {
    return { anchor: a, status: "moved", relocated: { start: found + 1, end: found + len } };
  }
  return {
    anchor: a,
    status: "stale",
    detail: slice ? "anchored text changed" : `range beyond end of file (${lines.length} lines)`,
  };
}

/** Search outward from `origin` so the nearest matching window wins. */
function findWindow(lines: string[], len: number, hash: string, origin: number): number {
  const last = lines.length - len;
  if (last < 0) return -1;
  const maxDist = Math.max(origin, last - origin);
  for (let d = 0; d <= maxDist; d++) {
    for (const pos of d === 0 ? [origin] : [origin - d, origin + d]) {
      if (pos < 0 || pos > last) continue;
      if (hashLines(lines.slice(pos, pos + len)) === hash) return pos;
    }
  }
  return -1;
}

const SEVERITY: AnchorStatus[] = ["ok", "moved", "unsealed", "stale", "missing"];

export function worst(statuses: AnchorStatus[]): AnchorStatus {
  return statuses.reduce<AnchorStatus>((w, s) => (SEVERITY.indexOf(s) > SEVERITY.indexOf(w) ? s : w), "ok");
}

export function checkItem(item: Claim | Probe, kind: "claim" | "probe", cache: SourceCache): ItemReport {
  const anchors = item.anchors.map((a) => checkAnchor(a, cache));
  return { kind, id: item.id, anchors, status: worst(anchors.map((r) => r.status)) };
}

export function checkDocument(doc: HcsDocument, cache: SourceCache): ItemReport[] {
  return [
    ...doc.claims.map((c) => checkItem(c, "claim", cache)),
    ...doc.probes.map((p) => checkItem(p, "probe", cache)),
  ];
}

export interface SealResult {
  sealed: number;
  relocated: number;
  rehashed: number;
}

/**
 * Write hashes into unsealed anchors, follow moved anchors to their new range and,
 * with `rehash`, accept the current content of stale anchors (a human asserts the claim still holds).
 */
export function seal(doc: HcsDocument, cache: SourceCache, opts: { rehash?: boolean; ids?: Set<string> } = {}): SealResult {
  const result: SealResult = { sealed: 0, relocated: 0, rehashed: 0 };
  for (const item of [...doc.claims, ...doc.probes]) {
    if (opts.ids && !opts.ids.has(item.id)) continue;
    for (const a of item.anchors) {
      const r = checkAnchor(a, cache);
      if (r.status === "unsealed") {
        const h = currentHash(a, cache);
        if (h) {
          a.hash = h;
          result.sealed++;
        }
      } else if (r.status === "moved" && r.relocated) {
        a.start = r.relocated.start;
        a.end = r.relocated.end;
        result.relocated++;
      } else if (r.status === "stale" && opts.rehash) {
        const h = currentHash(a, cache);
        if (h) {
          a.hash = h;
          result.rehashed++;
        }
      }
    }
  }
  return result;
}

// Deterministic anchor verification: hashing, relocation and staleness. No LLM involved.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Anchor, Claim, HcsDocument, Probe } from "./format.js";
import { collectSources } from "./sources.js";
import { findSymbol, languageOf, listSymbols, type SymbolRange } from "./symbols.js";

export const HASH_LENGTH = 12;

export type AnchorStatus = "ok" | "moved" | "stale" | "missing" | "unsealed";

export interface AnchorReport {
  anchor: Anchor;
  status: AnchorStatus;
  /** Where the anchored text was found when status is "moved" (new lines, or new file and symbol). */
  relocated?: { start?: number; end?: number; path?: string; symbol?: string };
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

/** Symbol anchors hash with all whitespace removed, so reformatting and re-indenting do not break them. */
export function hashSymbolLines(lines: string[]): string {
  return hashText(lines.join("\n").replace(/\s+/g, ""));
}

export function anchorHash(a: Anchor, lines: string[]): string {
  return a.symbol !== undefined ? hashSymbolLines(lines) : hashLines(lines);
}

/** Directory against which anchor paths are resolved. */
export function rootDir(doc: HcsDocument, hcsPath: string): string {
  return resolve(dirname(resolve(hcsPath)), doc.headers.root || ".");
}

/** Resolve `path` against the root and refuse anything outside it, including through symlinks. */
export function insideRoot(root: string, path: string): string {
  const deny = () => new Error("path must be inside the project root");
  const escapes = (rel: string) => !rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (escapes(rel)) throw deny();
  if (existsSync(full) && escapes(relative(realpathSync(root), realpathSync(full)))) throw deny();
  return rel;
}

export class SourceCache {
  private files = new Map<string, string[] | null>();
  constructor(public root: string) {}

  /** Lines of a file under the root; null when it does not exist or lies outside the root (a hostile anchor). */
  lines(path: string): string[] | null {
    if (!this.files.has(path)) {
      let full: string | undefined;
      try {
        full = resolve(this.root, insideRoot(this.root, path));
      } catch {
        full = undefined;
      }
      if (!full || !existsSync(full) || !statSync(full).isFile()) this.files.set(path, null);
      else this.files.set(path, normalizeLines(readFileSync(full, "utf8")));
    }
    return this.files.get(path)!;
  }

  private fileList?: string[];

  /** Source files under the root (used to find symbols that moved to another file). */
  sourceFiles(): string[] {
    this.fileList ??= collectSources(this.root);
    return this.fileList;
  }

  symbol(path: string, symbol: string): SymbolRange | null {
    const lines = this.lines(path);
    return lines ? findSymbol(path, lines, symbol) : null;
  }

  /** Text covered by an anchor, or null when the file, range or symbol does not exist. */
  slice(a: Anchor): string[] | null {
    const lines = this.lines(a.path);
    if (!lines) return null;
    if (a.symbol !== undefined) {
      const r = findSymbol(a.path, lines, a.symbol);
      return r ? lines.slice(r.start - 1, r.end) : null;
    }
    if (a.start === undefined) return lines;
    const end = a.end ?? a.start;
    if (end > lines.length) return null;
    return lines.slice(a.start - 1, end);
  }
}

/** Compute the hash an anchor should carry right now (null if the target does not exist). */
export function currentHash(a: Anchor, cache: SourceCache): string | null {
  const s = cache.slice(a);
  return s ? anchorHash(a, s) : null;
}

/** Look for a symbol with the same last name and the same content hash in other files of the same language. */
function findMovedSymbol(a: Anchor, cache: SourceCache): { path: string; symbol: string } | null {
  if (!a.symbol || !a.hash) return null;
  const short = a.symbol.split(".").pop()!;
  const lang = languageOf(a.path);
  for (const f of cache.sourceFiles()) {
    if (f === a.path || languageOf(f) !== lang) continue;
    const lines = cache.lines(f);
    if (!lines || !lines.some((l) => l.includes(short))) continue;
    for (const s of listSymbols(f, lines)) {
      if (s.name.split(".").pop() !== short && s.name !== a.symbol) continue;
      if (hashSymbolLines(lines.slice(s.start - 1, s.end)) === a.hash) return { path: f, symbol: s.name };
    }
  }
  return null;
}

function checkSymbolAnchor(a: Anchor, cache: SourceCache): AnchorReport {
  const lines = cache.lines(a.path);
  const range = lines ? findSymbol(a.path, lines, a.symbol!) : null;
  if (range && !a.hash) return { anchor: a, status: "unsealed", detail: "anchor has no hash; run `hcs seal`" };
  if (range && lines) {
    if (hashSymbolLines(lines.slice(range.start - 1, range.end)) === a.hash) return { anchor: a, status: "ok" };
    return { anchor: a, status: "stale", detail: `symbol changed (lines ${range.start}-${range.end})` };
  }
  const moved = findMovedSymbol(a, cache);
  if (moved) return { anchor: a, status: "moved", relocated: moved };
  if (!lines) return { anchor: a, status: "missing", detail: "file not found" };
  return { anchor: a, status: a.hash ? "missing" : "unsealed", detail: `symbol "${a.symbol}" not found` };
}

export function checkAnchor(a: Anchor, cache: SourceCache): AnchorReport {
  if (a.symbol !== undefined) return checkSymbolAnchor(a, cache);
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
        if (r.relocated.path !== undefined) a.path = r.relocated.path;
        if (r.relocated.symbol !== undefined) a.symbol = r.relocated.symbol;
        if (r.relocated.start !== undefined) {
          a.start = r.relocated.start;
          a.end = r.relocated.end;
        }
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

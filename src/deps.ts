// Dependency-aware invalidation: a claim about `fee()` may stop being true when `fee` calls a helper that changed,
// even though `fee`'s own text did not. A symbol anchor can carry a second hash, of the symbols its symbol uses
// directly (same file, or imported by name), so `hcs check` can ask for a review. Lightweight and heuristic:
// identifier matching, depth 1, JavaScript/TypeScript and Python only.

import { dirname, posix } from "node:path";
import { hashSymbolLines, hashText, type SourceCache } from "./anchors.js";
import type { Anchor } from "./format.js";
import { codeLines, findSymbol, listSymbols } from "./symbols.js";

const JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const PY = /\.(py|pyi)$/i;

/** Whether dependency fingerprints are computed for this file. */
export function supportsDeps(path: string): boolean {
  return JS.test(path) || PY.test(path);
}

export interface Dependency {
  path: string;
  symbol: string;
}

/** Names imported by a file: local name -> { module specifier as written, imported name }. */
function imports(path: string, lines: string[]): Map<string, { from: string; name: string }> {
  const out = new Map<string, { from: string; name: string }>();
  const text = lines.join("\n");
  if (JS.test(path)) {
    for (const m of text.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      for (const part of m[1].split(",")) {
        const p = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
        if (p) out.set(p[2] ?? p[1], { from: m[2], name: p[1] });
      }
    }
  } else {
    for (const m of text.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+\(?([^)\n]*)\)?/gm)) {
      for (const part of m[2].split(",")) {
        const p = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
        if (p) out.set(p[2] ?? p[1], { from: m[1], name: p[1] });
      }
    }
  }
  return out;
}

/** The file a module specifier names, relative to the root, if it exists. Only relative or in-project modules. */
function resolveModule(path: string, from: string, cache: SourceCache): string | null {
  const exists = (p: string) => (p && !p.startsWith("..") && cache.lines(p) ? p : null);
  if (JS.test(path)) {
    if (!from.startsWith(".")) return null;
    const base = posix.normalize(posix.join(dirname(path).split("\\").join("/"), from));
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
    for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.js`]) {
      const hit = exists(c);
      if (hit) return hit;
    }
    return null;
  }
  const dots = /^\.*/.exec(from)![0].length;
  const rest = from.slice(dots).split(".").filter(Boolean).join("/");
  let dir = dots ? dirname(path).split("\\").join("/") : "";
  for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  const base = posix.normalize(posix.join(dir === "." ? "" : dir, rest)).replace(/^\.\/?/, "");
  return exists(`${base}.py`) ?? exists(`${base}/__init__.py`);
}

/**
 * Symbols that the anchored symbol uses directly: other top-level symbols of its file, methods of its own class,
 * and names it imports from project files. Sorted, without duplicates; empty for unsupported languages.
 */
export function dependencies(a: Anchor, cache: SourceCache): Dependency[] {
  if (a.symbol === undefined || !supportsDeps(a.path)) return [];
  const lines = cache.lines(a.path);
  const range = lines ? findSymbol(a.path, lines, a.symbol) : null;
  if (!lines || !range) return [];
  const self = listSymbols(a.path, lines).find((s) => s.start === range.start && s.end === range.end)?.name ?? a.symbol;
  const parent = self.includes(".") ? self.slice(0, self.lastIndexOf(".")) : "";
  const body = codeLines(a.path, lines).slice(range.start - 1, range.end).join("\n");
  const used = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const deps = new Map<string, Dependency>();
  for (const s of listSymbols(a.path, lines)) {
    if (s.name === self || s.name.startsWith(`${self}.`) || self.startsWith(`${s.name}.`)) continue;
    const sibling = s.name.includes(".") ? s.name.slice(0, s.name.lastIndexOf(".")) === parent && parent !== "" : true;
    const short = s.name.split(".").pop()!;
    if (sibling && used.has(short)) deps.set(`${a.path}::${s.name}`, { path: a.path, symbol: s.name });
  }
  for (const [local, imp] of imports(a.path, lines)) {
    if (!used.has(local)) continue;
    const target = resolveModule(a.path, imp.from, cache);
    if (target && cache.symbol(target, imp.name)?.name === imp.name) deps.set(`${target}::${imp.name}`, { path: target, symbol: imp.name });
  }
  return [...deps.values()].sort((x, y) => (`${x.path}::${x.symbol}` < `${y.path}::${y.symbol}` ? -1 : 1));
}

/** Hash of the dependencies' current text; undefined when the symbol has none. */
export function depsHash(a: Anchor, cache: SourceCache): string | undefined {
  const deps = dependencies(a, cache);
  if (!deps.length) return undefined;
  const entries = deps.map((d) => {
    const lines = cache.lines(d.path);
    const r = lines ? findSymbol(d.path, lines, d.symbol) : null;
    return `${d.path}::${d.symbol}=${r && lines ? hashSymbolLines(lines.slice(r.start - 1, r.end)) : "missing"}`;
  });
  return hashText(entries.join("\n"));
}

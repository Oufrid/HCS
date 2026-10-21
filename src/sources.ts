// Source discovery and chunking. Works for any text: code, prose, transcripts.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { normalizeLines } from "./anchors.js";

const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "vendor/",
  ".venv/",
  "__pycache__/",
  ".hcs-cache/",
  "*.hcs",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.svg",
];

export interface SourceOptions {
  /** Skip files larger than this many bytes. */
  maxBytes?: number;
  /** Extra ignore patterns (same syntax as .hcsignore). */
  ignore?: string[];
}

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*") {
      re += p[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += p[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  const suffix = dirOnly ? "/" : "(?:/|$)";
  return new RegExp(prefix + re + suffix);
}

function loadIgnores(root: string, extra: string[] = []): RegExp[] {
  const patterns = [...DEFAULT_IGNORES, ...extra];
  const file = join(root, ".hcsignore");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) patterns.push(t);
    }
  }
  return patterns.map(globToRegExp);
}

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === ".git" || name === "node_modules") continue;
      walk(root, full, out);
    } else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
}

function isText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/** List text files under `paths` (relative to `root`), honoring .gitignore (inside git repos) and .hcsignore. */
export function collectSources(root: string, paths: string[] = ["."], opts: SourceOptions = {}): string[] {
  const absRoot = resolve(root);
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const ignores = loadIgnores(absRoot, opts.ignore);
  let all = gitFiles(absRoot);
  if (!all) {
    all = [];
    walk(absRoot, absRoot, all);
  }
  const wanted = paths.map((p) => relative(absRoot, resolve(absRoot, p)).split(sep).join("/"));
  // A file named explicitly is always read, even if .gitignore excludes it.
  for (const w of wanted) {
    const full = join(absRoot, w);
    if (w && !all.includes(w) && existsSync(full) && statSync(full).isFile()) all.push(w);
  }
  const result: string[] = [];
  for (const f of all.sort()) {
    if (!wanted.some((w) => w === "" || f === w || f.startsWith(`${w}/`))) continue;
    if (ignores.some((re) => re.test(f))) continue;
    const full = join(absRoot, f);
    if (!existsSync(full)) continue;
    const st = statSync(full);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) continue;
    if (!isText(readFileSync(full))) continue;
    result.push(f);
  }
  return result;
}

export interface Chunk {
  path: string;
  /** 1-based inclusive line range within the file. */
  start: number;
  end: number;
  lines: string[];
}

/** Split a file into chunks of at most `maxLines`, preferring to cut at blank lines. */
export function chunkFile(path: string, text: string, maxLines = 250): Chunk[] {
  const lines = normalizeLines(text);
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(start + maxLines, lines.length);
    if (end < lines.length) {
      for (let k = end; k > start + Math.floor(maxLines * 0.6); k--) {
        if (lines[k - 1].trim() === "") {
          end = k;
          break;
        }
      }
    }
    chunks.push({ path, start: start + 1, end, lines: lines.slice(start, end) });
    start = end;
  }
  return chunks;
}

export function numbered(chunk: Chunk): string {
  const width = String(chunk.end).length;
  return chunk.lines.map((l, i) => `${String(chunk.start + i).padStart(width)}| ${l}`).join("\n");
}

export type Profile = "code" | "docs" | "conversation";

const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc|org|tex|html?)$/i;

export function profileFor(path: string, text: string): Profile {
  if (text.startsWith("<!-- hcs:transcript -->")) return "conversation";
  return DOC_EXT.test(path) ? "docs" : "code";
}

/**
 * Locate a quoted passage inside a chunk, ignoring whitespace, case and Markdown formatting.
 * Returns the 1-based line range it spans, or null if the quote is not really in the source.
 */
export function locateQuote(chunk: Chunk, quote: string): { start: number; end: number } | null {
  const q = normalizeForQuote(quote);
  if (q.length < 3) return null;
  let joined = "";
  const offsets: number[] = [];
  for (const l of chunk.lines) {
    offsets.push(joined.length);
    joined += normalizeForQuote(l) + " ";
  }
  const at = joined.indexOf(q);
  if (at === -1) return null;
  const lineAt = (pos: number) => {
    let i = 0;
    while (i + 1 < offsets.length && offsets[i + 1] <= pos) i++;
    return chunk.start + i;
  };
  return { start: lineAt(at), end: lineAt(at + q.length - 1) };
}

/**
 * Normalization for quote matching. Models quote the words of a passage but often drop its Markdown markup
 * (`code`, **bold**, [links](url)) or switch quote styles, so those are ignored on both sides; the words
 * themselves must still match exactly.
 */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

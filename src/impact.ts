// `hcs impact`: which claims and probes cite code that a diff changes. Reviewers then know which statements of the
// context to re-read, including claims the author already re-sealed (those pass `hcs check` but still deserve a look).

import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { checkDocument, type AnchorStatus, type SourceCache } from "./anchors.js";
import { formatAnchor, parse, type Anchor, type Claim, type HcsDocument, type Probe } from "./format.js";

/** A changed region of the new version of a file, 1-based inclusive. A pure deletion is the lines around it. */
export interface Hunk {
  start: number;
  end: number;
}

export interface FileChange {
  /** Path in the new version (the old one for deletions), relative to the repository top level. */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  oldPath?: string;
  hunks: Hunk[];
}

/** Parse `git diff -U0 -M` output. Only file names and hunk headers are needed. */
export function parseUnifiedDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | undefined;
  const unquote = (p: string) => (p.startsWith('"') ? JSON.parse(p) : p);
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Fallback for changes without ---/+++ lines (pure renames, mode changes): the header names the file.
      const h = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { path: h ? h[2] : "", status: "modified", hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) current.path = unquote(line.slice(10));
    else if (line.startsWith("--- ")) {
      if (line !== "--- /dev/null") current.oldPath = unquote(line.slice(4)).replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null") current.path = unquote(line.slice(4)).replace(/^b\//, "");
    }
    else if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      // Lines removed without replacement sit between `start` and `start + 1` of the new file.
      current.hunks.push(count === 0 ? { start: Math.max(1, start), end: start + 1 } : { start, end: start + count - 1 });
    }
  }
  for (const f of files) {
    if (f.status === "deleted" && f.oldPath) f.path = f.oldPath;
    if (f.status !== "renamed") delete f.oldPath;
  }
  return files.filter((f) => f.path);
}

/** Path of `root` relative to the repository top level ("" at the top), for links to files on the forge. */
export function gitPrefix(root: string): string {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
  return relative(top, resolve(root)).split("\\").join("/");
}

/** Run git diff between `base` and the working tree, for files under `root`, with paths relative to `root`. */
export function gitChanges(root: string, base: string): FileChange[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const top = git("rev-parse", "--show-toplevel").trim();
  const prefix = relative(top, resolve(root)).split("\\").join("/");
  const under = (p: string) => !prefix || p === prefix || p.startsWith(`${prefix}/`);
  const strip = (p: string) => (prefix ? p.slice(prefix.length + 1) : p);
  return parseUnifiedDiff(git("diff", "--no-color", "--no-ext-diff", "-U0", "-M", base, "--", "."))
    .filter((f) => under(f.path) || (f.oldPath !== undefined && under(f.oldPath)))
    .map((f) => ({ ...f, path: strip(f.path), ...(f.oldPath !== undefined ? { oldPath: strip(f.oldPath) } : {}) }));
}

export interface AnchorImpact {
  anchor: Anchor;
  /** Current lines of the anchored text, when it can be located. */
  lines?: Hunk;
  reason: string;
}

export interface ItemImpact {
  kind: "claim" | "probe";
  id: string;
  text: string;
  status: AnchorStatus;
  anchors: AnchorImpact[];
}

export interface ImpactReport {
  base: string;
  filesChanged: number;
  items: ItemImpact[];
  /** Claims added, removed or edited in the .hcs file itself by the diff. */
  claimsAdded: string[];
  claimsRemoved: string[];
  claimsEdited: string[];
}

const overlaps = (a: Hunk, b: Hunk) => a.start <= b.end && b.start <= a.end;

function anchorRange(a: Anchor, cache: SourceCache): Hunk | undefined {
  if (a.symbol !== undefined) {
    const s = cache.symbol(a.path, a.symbol);
    return s ? { start: s.start, end: s.end } : undefined;
  }
  const lines = cache.lines(a.path);
  if (!lines) return undefined;
  if (a.start === undefined) return { start: 1, end: Math.max(1, lines.length) };
  return { start: a.start, end: a.end ?? a.start };
}

function anchorImpact(a: Anchor, status: AnchorStatus, cache: SourceCache, changes: Map<string, FileChange>, renamedFrom: Map<string, FileChange>): AnchorImpact | null {
  const lines = anchorRange(a, cache);
  const change = changes.get(a.path);
  const gone = renamedFrom.get(a.path);
  if (gone) return { anchor: a, reason: gone.status === "deleted" ? "file deleted" : `file renamed to ${gone.path}` };
  if (change?.status === "added") return { anchor: a, lines, reason: "file added in this diff" };
  if (change && lines) {
    const hit = change.hunks.filter((h) => overlaps(h, lines));
    if (hit.length) return { anchor: a, lines, reason: `changed lines ${hit.map((h) => (h.start === h.end ? h.start : `${h.start}-${h.end}`)).join(", ")}` };
  }
  if (status !== "ok" && status !== "unsealed") return { anchor: a, lines, reason: status };
  return null;
}

function claimsDelta(base: HcsDocument | undefined, doc: HcsDocument) {
  if (!base) return { claimsAdded: [], claimsRemoved: [], claimsEdited: [] };
  const key = (c: Claim) => `${c.text}\n${c.anchors.map((a) => formatAnchor(a, false)).join("\n")}`;
  const before = new Map(base.claims.map((c) => [c.id, key(c)]));
  const after = new Map(doc.claims.map((c) => [c.id, key(c)]));
  return {
    claimsAdded: [...after.keys()].filter((id) => !before.has(id)),
    claimsRemoved: [...before.keys()].filter((id) => !after.has(id)),
    claimsEdited: [...after].filter(([id, k]) => before.has(id) && before.get(id) !== k).map(([id]) => id),
  };
}

/**
 * Claims and probes whose anchors overlap changed lines, point to deleted or renamed files, or no longer verify.
 * `baseDoc` is the .hcs file as it was at the base revision, to list claims the diff itself added, removed or edited.
 */
export function impact(doc: HcsDocument, cache: SourceCache, changes: FileChange[], base: string, baseDoc?: HcsDocument): ImpactReport {
  const byPath = new Map(changes.filter((c) => c.status !== "deleted").map((c) => [c.path, c]));
  const gone = new Map<string, FileChange>();
  for (const c of changes) {
    if (c.status === "deleted") gone.set(c.path, c);
    if (c.status === "renamed" && c.oldPath) gone.set(c.oldPath, c);
  }
  const reports = new Map(checkDocument(doc, cache).map((r) => [`${r.kind}:${r.id}`, r]));
  const items: ItemImpact[] = [];
  const visit = (item: Claim | Probe, kind: "claim" | "probe") => {
    const report = reports.get(`${kind}:${item.id}`)!;
    const anchors = item.anchors
      .map((a, i) => anchorImpact(a, report.anchors[i].status, cache, byPath, gone))
      .filter((x): x is AnchorImpact => x !== null);
    if (anchors.length) items.push({ kind, id: item.id, text: "text" in item ? item.text : item.question, status: report.status, anchors });
  };
  doc.claims.forEach((c) => visit(c, "claim"));
  doc.probes.forEach((p) => visit(p, "probe"));
  return { base, filesChanged: changes.length, items, ...claimsDelta(baseDoc, doc) };
}

/** The .hcs file as it was at `base`, if it existed there. */
export function baseDocument(file: string, base: string): HcsDocument | undefined {
  try {
    const abs = resolve(file);
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(abs, ".."), encoding: "utf8" }).trim();
    const rel = relative(top, abs).split("\\").join("/");
    return parse(execFileSync("git", ["show", `${base}:${rel}`], { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}

/** Marker that identifies the bot's comment, so it is updated instead of duplicated. */
export const COMMENT_MARKER = "<!-- hcs-impact -->";

/**
 * Markdown for a pull-request comment. `linkBase` (e.g. https://github.com/o/r/blob/<sha>/<root>) turns anchors into
 * links to the exact lines.
 */
export function impactMarkdown(r: ImpactReport, file: string, linkBase?: string): string {
  const out = [COMMENT_MARKER];
  const claims = r.items.filter((i) => i.kind === "claim");
  const probes = r.items.filter((i) => i.kind === "probe");
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const link = (a: AnchorImpact) => {
    const label = `\`${formatAnchor(a.anchor, false)}\``;
    if (!linkBase || !a.lines) return label;
    const range = a.lines.start === a.lines.end ? `#L${a.lines.start}` : `#L${a.lines.start}-L${a.lines.end}`;
    return `[${label}](${linkBase.replace(/\/+$/, "")}/${a.anchor.path.split("/").map(encodeURIComponent).join("/")}${range})`;
  };
  if (!r.items.length && !r.claimsAdded.length && !r.claimsRemoved.length && !r.claimsEdited.length) {
    out.push(`### HCS: no claim in \`${file}\` cites the code changed here`, "", `${r.filesChanged} file(s) changed. Nothing in the context needs review.`);
    return out.join("\n") + "\n";
  }
  out.push(
    `### HCS: ${claims.length} claim(s) and ${probes.length} probe(s) in \`${file}\` cite code changed here`,
    "",
    "Check that each statement still holds. If it does: `hcs seal " + file + " --rehash --ids <ids>`; if not, edit it.",
    "",
  );
  if (r.items.length) {
    out.push("| Item | Status | Statement | Cited source | Why |", "|---|---|---|---|---|");
    for (const i of r.items) {
      for (const [k, a] of i.anchors.entries()) {
        const first = k === 0;
        out.push(
          `| ${first ? `\`${i.id}\`` : ""} | ${first ? i.status : ""} | ${first ? cell(i.text.length > 160 ? `${i.text.slice(0, 157)}...` : i.text) : ""} | ${link(a)} | ${cell(a.reason)} |`,
        );
      }
    }
  }
  const delta = [
    r.claimsAdded.length ? `added ${r.claimsAdded.map((x) => `\`${x}\``).join(", ")}` : "",
    r.claimsEdited.length ? `edited ${r.claimsEdited.map((x) => `\`${x}\``).join(", ")}` : "",
    r.claimsRemoved.length ? `removed ${r.claimsRemoved.map((x) => `\`${x}\``).join(", ")}` : "",
  ].filter(Boolean);
  if (delta.length) out.push("", `Claims changed in \`${file}\` by this diff: ${delta.join("; ")}.`);
  out.push("", `<sub>${r.filesChanged} file(s) changed since \`${r.base.slice(0, 12)}\`. Generated by \`hcs impact\`; no model was used.</sub>`);
  return out.join("\n") + "\n";
}

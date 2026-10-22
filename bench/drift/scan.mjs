#!/usr/bin/env node
// Drift in real agent context files: for public repositories that have an AGENTS.md or CLAUDE.md, list the file
// paths these files mention and check whether they still exist, and since when a broken one has been broken.
// Deterministic and free (git only, no LLM). A lower bound: it sees broken file references, not false statements.
//   node bench/drift/scan.mjs owner/repo ...   (clones into bench/.work/drift, writes bench/drift/results.json)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, "..", ".work", "drift");
mkdirSync(work, { recursive: true });
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const CONTEXT = /^(AGENTS|CLAUDE)\.md$/i;

/** Path-like tokens in Markdown: inline code and link targets that look like repository paths. */
function references(text) {
  const out = new Map();
  const add = (raw, line) => {
    let p = raw.trim().replace(/^<|>$/g, "").replace(/[#?].*$/, "").replace(/:\d+(-\d+)?$/, "").replace(/^\.\//, "").replace(/\/$/, "");
    if (!p || /\s|^https?:|^[@~$]|[*{}<>|`'"]|^\.\.?$|^-|^\//.test(p)) return;
    const looksLikePath = p.includes("/") || /\.[a-z0-9]{1,6}$/i.test(p);
    if (!looksLikePath || /^\d+(\.\d+)+$/.test(p) || /^[a-z]+\.[a-z]+\(/i.test(p)) return;
    if (!out.has(p)) out.set(p, line);
  };
  text.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/`([^`\n]+)`/g)) add(m[1], i + 1);
    for (const m of l.matchAll(/\]\(([^)\s]+)\)/g)) add(m[1], i + 1);
  });
  return out;
}

const results = [];
for (const slug of process.argv.slice(2)) {
  const dir = join(work, slug.replace("/", "__"));
  try {
    if (!existsSync(dir)) execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--shallow-since=2024-06-01", `https://github.com/${slug}`, dir], { stdio: "ignore", timeout: 600_000 });
    const head = git(dir, "rev-parse", "HEAD").trim();
    const tree = git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
    const files = new Set(tree);
    const dirs = new Set(tree.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
    const contexts = tree.filter((f) => CONTEXT.test(posix.basename(f)) && !/(^|\/)(node_modules|vendor|third_party|testdata|fixtures?)\//.test(f)).slice(0, 20);
    if (!contexts.length) {
      results.push({ repo: slug, head, contexts: [] });
      console.log(`${slug}: no AGENTS.md or CLAUDE.md`);
      continue;
    }
    const entry = { repo: slug, head, contexts: [] };
    for (const ctx of contexts) {
      const text = git(dir, "show", `HEAD:${ctx}`);
      const base = posix.dirname(ctx) === "." ? "" : posix.dirname(ctx);
      const refs = [...references(text)];
      const lastEdit = git(dir, "log", "-1", "--format=%cs", "HEAD", "--", ctx).trim();
      const broken = [];
      for (const [p, line] of refs) {
        const candidates = [p, base ? posix.join(base, p) : p];
        if (candidates.some((c) => files.has(c) || dirs.has(c))) continue;
        // A bare file name (no slash) may be a generic mention; count it only if it exists nowhere in the tree.
        if (!p.includes("/") && tree.some((f) => posix.basename(f) === p)) continue;
        // When did the path disappear? The last commit in the shallow history that touched it.
        const gone = git(dir, "log", "-1", "--format=%cs %h", "HEAD", "--", p).trim();
        broken.push({ path: p, line, removed: gone || null });
      }
      entry.contexts.push({ file: ctx, bytes: text.length, lastEdit, references: refs.length, broken });
      console.log(`${slug} ${ctx}: ${refs.length} path references, ${broken.length} broken${broken.length ? `: ${broken.slice(0, 4).map((b) => b.path).join(", ")}` : ""}`);
    }
    results.push(entry);
  } catch (e) {
    results.push({ repo: slug, error: String(e.message ?? e).slice(0, 200) });
    console.log(`${slug}: error ${String(e.message ?? e).slice(0, 120)}`);
  }
}
const out = join(here, "results.json");
const previous = existsSync(out) ? JSON.parse((await import("node:fs")).readFileSync(out, "utf8")) : [];
const merged = [...previous.filter((p) => !results.some((r) => r.repo === p.repo)), ...results];
writeFileSync(out, JSON.stringify(merged, null, 1) + "\n");

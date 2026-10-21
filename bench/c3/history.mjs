#!/usr/bin/env node
// C3 measurement: replay this repository's history and list every "review" a dependency hash would have raised.
// For each pair of consecutive commits, for each symbol anchor of project.hcs (as of HEAD) that exists in both:
// own text unchanged + a dependency changed = a review event. Writes bench/c3/events.json; run from the repo root.
//   npm run build && node bench/c3/history.mjs [first-commit]

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSymbolLines, SourceCache } from "../../dist/src/anchors.js";
import { dependencies } from "../../dist/src/deps.js";
import { parse } from "../../dist/src/format.js";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const first = process.argv[2];
const commits = git("rev-list", "--reverse", "--first-parent", first ? `${first}^..HEAD` : "HEAD").trim().split("\n");
const doc = parse(readFileSync("project.hcs", "utf8"));
const anchors = [];
for (const c of doc.claims) for (const a of c.anchors) if (a.symbol && /\.(ts|py|mjs)$/.test(a.path)) anchors.push({ claim: c.id, text: c.text, path: a.path, symbol: a.symbol });

const tmp = mkdtempSync(join(tmpdir(), "hcs-c3-"));
const trees = commits.map((sha, i) => {
  const dir = join(tmp, String(i));
  mkdirSync(dir);
  execFileSync("sh", ["-c", `git archive ${sha} | tar -x -C ${dir}`]);
  return new SourceCache(dir);
});

/** Own hash and per-dependency hashes of an anchor in one tree, or null when the symbol does not exist there. */
function snapshot(cache, a) {
  const lines = cache.lines(a.path);
  const r = lines ? cache.symbol(a.path, a.symbol) : null;
  if (!lines || !r) return null;
  const deps = {};
  for (const d of dependencies({ path: a.path, symbol: a.symbol }, cache)) {
    const dl = cache.lines(d.path);
    const dr = dl ? cache.symbol(d.path, d.symbol) : null;
    deps[`${d.path}::${d.symbol}`] = dr ? hashSymbolLines(dl.slice(dr.start - 1, dr.end)) : "missing";
  }
  return { own: hashSymbolLines(lines.slice(r.start - 1, r.end)), deps };
}

const events = [];
let pairs = 0;
let stale = 0;
for (let i = 1; i < commits.length; i++) {
  for (const a of anchors) {
    const before = snapshot(trees[i - 1], a);
    const after = snapshot(trees[i], a);
    if (!before || !after) continue;
    pairs++;
    if (before.own !== after.own) {
      stale++;
      continue;
    }
    const keys = new Set([...Object.keys(before.deps), ...Object.keys(after.deps)]);
    const changed = [...keys].filter((k) => before.deps[k] !== after.deps[k]);
    if (changed.length) {
      events.push({ commit: commits[i].slice(0, 7), subject: git("log", "-1", "--format=%s", commits[i]).trim(), claim: a.claim, anchor: `${a.path}::${a.symbol}`, text: a.text, changed });
    }
  }
}
rmSync(tmp, { recursive: true, force: true });
writeFileSync("bench/c3/events.json", JSON.stringify({ commits: commits.length, anchors: anchors.length, pairs, stale, events }, null, 2) + "\n");
console.log(`${commits.length} commits, ${anchors.length} symbol anchors, ${pairs} anchor x commit-pair observations: ${stale} own changes (stale), ${events.length} review events`);

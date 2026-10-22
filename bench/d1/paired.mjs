// Pooled paired comparison of two D1 conditions for one answering family.
//   node bench/d1/paired.mjs <results-dir-name> <condition-a> <condition-b> <repo-dir>...
// e.g. node bench/d1/paired.mjs mistral_ministral-14b-latest--gemini_gemini-3.8-flash--independent--v2 \
//        hcs-compact summary expressjs__express psf__requests sirupsen__logrus
// Pairs probes by repository and id, and prints each condition's fidelity and the difference a - b with a 95%
// paired bootstrap CI (HCS's bootstrapCI: 2,000 resamples, seed 42). Only probes scored in both conditions count.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { bootstrapCI } = await import(join(here, "../../dist/src/score.js"));
const [dir, a, b, ...repos] = process.argv.slice(2);
if (!dir || !a || !b || !repos.length) {
  console.error("usage: paired.mjs <results-dir-name> <condition-a> <condition-b> <repo-dir>...");
  process.exit(2);
}

const load = (repo, cond) => JSON.parse(readFileSync(join(here, "results", repo, dir, `${cond}.json`), "utf8")).results;
const pct = (x) => (100 * x).toFixed(1);
const xa = [];
const xb = [];
for (const repo of repos) {
  const ra = load(repo, a);
  const rb = load(repo, b);
  const ids = Object.keys(ra).filter((id) => id in rb);
  const sa = ids.map((id) => ra[id].points);
  const sb = ids.map((id) => rb[id].points);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  console.log(`${repo}: ${ids.length} probes, ${a} ${pct(mean(sa))}%, ${b} ${pct(mean(sb))}%`);
  xa.push(...sa);
  xb.push(...sb);
}
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const show = (name, v) => {
  const [lo, hi] = bootstrapCI(v);
  console.log(`${name.padEnd(20)} ${pct(mean(v))}% [${pct(lo)}, ${pct(hi)}]`);
};
console.log(`pooled: ${xa.length} probes`);
show(a, xa);
show(b, xb);
const diff = xa.map((x, i) => x - xb[i]);
const [lo, hi] = bootstrapCI(diff);
console.log(`${a} - ${b}: ${pct(mean(diff))} [${pct(lo)}, ${pct(hi)}] points`);

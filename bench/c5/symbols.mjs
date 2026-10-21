// C5: compare the tree-sitter symbol back-end with the built-in heuristic on this repository's own
// TypeScript, JavaScript and Python files. Run after `npm run build`:  node bench/c5/symbols.mjs
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { listSymbols } from "../../dist/src/symbols.js";
import { normalizeLines } from "../../dist/src/anchors.js";
import { enableTreeSitter } from "../../dist/src/treesitter.js";

const files = execSync("git ls-files '*.ts' '*.mjs' '*.js' '*.py'").toString().trim().split("\n").filter((f) => !f.startsWith("conformance/cases/"));
const read = (f) => normalizeLines(readFileSync(f, "utf8"));
const heuristic = new Map(files.map((f) => [f, listSymbols(f, read(f))]));
await enableTreeSitter();
let both = 0, same = 0, onlyH = 0, onlyT = 0;
const diffs = [];
for (const f of files) {
  const t = new Map(listSymbols(f, read(f)).map((s) => [s.name, s]));
  const h = new Map(heuristic.get(f).map((s) => [s.name, s]));
  for (const [n, s] of h) {
    const o = t.get(n);
    if (!o) (onlyH++, diffs.push(`heuristic only    ${f}::${n} ${s.start}-${s.end}`));
    else if ((both++, o.start === s.start && o.end === s.end)) same++;
    else diffs.push(`different range   ${f}::${n} heuristic ${s.start}-${s.end}, tree-sitter ${o.start}-${o.end}`);
  }
  for (const [n, s] of t) if (!h.has(n)) (onlyT++, diffs.push(`tree-sitter only  ${f}::${n} ${s.start}-${s.end}`));
}
console.log(`${files.length} files`);
console.log(`symbols found by both: ${both}, same range: ${same} (${((100 * same) / both).toFixed(1)}%)`);
console.log(`found only by the heuristic: ${onlyH}; only by tree-sitter: ${onlyT}`);
console.log(diffs.join("\n"));

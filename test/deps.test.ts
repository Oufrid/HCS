import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDocument, seal, SourceCache } from "../src/anchors.js";
import { dependencies } from "../src/deps.js";
import { parse, serialize } from "../src/format.js";
import { tempProject } from "./helpers.js";

const TS = {
  "src/rates.ts": [
    'import { round, LIMIT as MAX } from "./util.js";',
    'import { unused } from "./util.js";',
    "",
    "export function fee(w: number): number {",
    "  if (w > MAX) throw new Error(\"helper and base are only words in a string\");",
    "  return round(base() + w * 4);",
    "}",
    "",
    "function base() {",
    "  return 25;",
    "}",
    "",
    "export class Cart {",
    "  total() {",
    "    return this.sum() * 2;",
    "  }",
    "  sum() {",
    "    return 1;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/util.ts": "export function round(x: number) {\n  return Math.round(x);\n}\n\nexport const LIMIT = 30;\n\nexport function unused() {\n  return 0;\n}\n",
};

test("dependencies: same-file symbols, class siblings and imported names, not words in strings", () => {
  const dir = tempProject(TS);
  const cache = new SourceCache(join(dir, "src"));
  const names = (symbol: string) => dependencies({ path: "rates.ts", symbol }, cache).map((d) => `${d.path}::${d.symbol}`);
  assert.deepEqual(names("fee"), ["rates.ts::base", "util.ts::LIMIT", "util.ts::round"]);
  assert.deepEqual(names("Cart.total"), ["rates.ts::Cart.sum"]);
  assert.deepEqual(names("base"), []);
  assert.deepEqual(dependencies({ path: "rates.ts", start: 1, end: 3 }, cache), [], "only symbol anchors");
  rmSync(dir, { recursive: true });
});

test("dependencies in Python: relative and package imports", () => {
  const dir = tempProject({
    "app/pricing.py": "from .util import round_up, LIMIT\nfrom app.tax import vat as v\n\n\ndef fee(w):\n    if w > LIMIT:\n        raise ValueError('round_up')\n    return round_up(base(w)) + v(w)\n\n\ndef base(w):\n    return 25 + w * 4\n",
    "app/util.py": "LIMIT = 30\n\n\ndef round_up(x):\n    return int(x + 0.5)\n",
    "app/tax.py": "def vat(x):\n    return x * 0.2\n",
    "app/__init__.py": "",
  });
  const cache = new SourceCache(dir);
  const deps = dependencies({ path: "app/pricing.py", symbol: "fee" }, cache).map((d) => `${d.path}::${d.symbol}`);
  // LIMIT is a module constant, not a def/class: the Python locator only knows functions and classes.
  assert.deepEqual(deps, ["app/pricing.py::base", "app/tax.py::vat", "app/util.py::round_up"]);
  rmSync(dir, { recursive: true });
});

test("check reports review when a dependency changes; seal --rehash accepts it; seal --deps adds hashes", () => {
  const dir = tempProject({ ...TS, "project.hcs": "HCS/0.2\n@root src\n[claims]\n#c1 Fee is 25 plus 4 per kg, rounded.\n  > rates.ts::fee\n#c2 LIMIT is 30.\n  > util.ts:5\n" });
  const file = join(dir, "project.hcs");
  const load = () => parse(readFileSync(file, "utf8"));
  const statuses = () => {
    const doc = load();
    return checkDocument(doc, new SourceCache(join(dir, "src"))).map((r) => `${r.id}:${r.status}`);
  };
  let doc = load();
  let r = seal(doc, new SourceCache(join(dir, "src")), { deps: true });
  assert.deepEqual(r, { sealed: 2, relocated: 0, rehashed: 0, deps: 1 });
  writeFileSync(file, serialize(doc));
  assert.match(readFileSync(file, "utf8"), /^HCS\/0.3\n[\s\S]*> rates.ts::fee #[0-9a-f]{12}\/[0-9a-f]{12}\n#c2 LIMIT is 30.\n  > util.ts:5 #[0-9a-f]{12}\n/);
  assert.deepEqual(statuses(), ["c1:ok", "c2:ok"]);

  // fee's own text is unchanged, but round() changed: fee's claim needs a review, nothing fails.
  writeFileSync(join(dir, "src/util.ts"), TS["src/util.ts"].replace("Math.round(x)", "Math.ceil(x)"));
  assert.deepEqual(statuses(), ["c1:review", "c2:ok"]);
  const report = checkDocument(load(), new SourceCache(join(dir, "src")))[0];
  assert.match(report.anchors[0].detail ?? "", /a symbol it uses changed \(uses base, util.ts::LIMIT, util.ts::round\)/);

  // A change to an unused export does not matter.
  writeFileSync(join(dir, "src/util.ts"), TS["src/util.ts"].replace("return 0", "return 1"));
  assert.deepEqual(statuses(), ["c1:ok", "c2:ok"]);

  writeFileSync(join(dir, "src/util.ts"), TS["src/util.ts"].replace("Math.round(x)", "Math.ceil(x)"));
  doc = load();
  r = seal(doc, new SourceCache(join(dir, "src")));
  assert.equal(r.rehashed, 0, "review is kept without --rehash");
  r = seal(doc, new SourceCache(join(dir, "src")), { rehash: true, ids: new Set(["c1"]) });
  assert.deepEqual(r, { sealed: 0, relocated: 0, rehashed: 1, deps: 1 });
  writeFileSync(file, serialize(doc));
  assert.deepEqual(statuses(), ["c1:ok", "c2:ok"]);
  rmSync(dir, { recursive: true });
});

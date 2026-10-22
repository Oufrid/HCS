#!/usr/bin/env node
// Produces input.hcs (from input.template.hcs) and expected.json for every case, using the reference
// implementation. Run it after adding or changing a case, then review the diff of the expected files:
// they are the standard, not a snapshot to accept blindly.
//
//   npm run build && node conformance/generate.mjs [case-name...]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentHash, SourceCache } from "../dist/src/anchors.js";
import { depsHash } from "../dist/src/deps.js";
import { parse, parseAnchor, serialize } from "../dist/src/format.js";
import { checkDocument } from "../dist/src/anchors.js";
import { hashForCertificate } from "../dist/src/score.js";
import { runCase, withCopy } from "./reference.mjs";

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "cases");
const only = process.argv.slice(2);

/**
 * `#HASH_<name>` marks an anchor sealed against the `seal_against` directory (the sources as they were when the
 * claim was written). `DIGEST_FULL` and `DIGEST_B<n>` become certificate digests at no budget or budget n; `DIGEST_C<n>` the same
 * with the compact render profile.
 */
function buildInput(dir) {
  const template = join(dir, "input.template.hcs");
  if (!existsSync(template)) return;
  const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  const lines = readFileSync(template, "utf8").split("\n");
  const sealed = new Map();
  let text = lines
    .map((l) => {
      const m = /^(\s*>\s*)(.+?)\s+#(HASH_\w+)\s*$/.exec(l);
      if (!m) return l;
      const cache = new SourceCache(join(dir, spec.args.seal_against));
      const anchor = parseAnchor(m[2]);
      const h = currentHash(anchor, cache);
      if (!h) throw new Error(`${dir}: cannot seal ${m[2]} against ${spec.args.seal_against}`);
      sealed.set(m[3], h);
      // #HASH_DEPS_<name> also records the dependency hash, as `hcs seal --deps` does.
      const d = m[3].startsWith("HASH_DEPS") ? depsHash(anchor, cache) : undefined;
      if (m[3].startsWith("HASH_DEPS") && !d) throw new Error(`${dir}: ${m[2]} has no dependencies in ${spec.args.seal_against}`);
      return `${m[1]}${m[2]} #${h}${d ? `/${d}` : ""}`;
    })
    .join("\n");
  if (/DIGEST_/.test(text)) {
    const doc = parse(text.replace(/DIGEST_\w+/g, "000000000000"));
    const cache = new SourceCache(join(dir, "src"));
    const status = new Map(checkDocument(doc, cache).filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));
    text = text.replace(/DIGEST_(FULL|B(\d+)|C(\d+))/g, (_, __, b, c) =>
      c ? hashForCertificate(doc, status, Number(c), "compact") : hashForCertificate(doc, status, b ? Number(b) : undefined),
    );
  }
  writeFileSync(join(dir, "input.hcs"), text);
}

let n = 0;
for (const name of readdirSync(casesDir).sort()) {
  if (only.length && !only.includes(name)) continue;
  const dir = join(casesDir, name);
  buildInput(dir);
  const expected = withCopy(dir, (copy) => runCase(copy));
  writeFileSync(join(dir, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
  n++;
}
console.log(`wrote expected.json for ${n} case(s)`);

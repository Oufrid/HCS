#!/usr/bin/env node
// Runs every conformance case with the TypeScript implementation and compares with expected.json.
//   npm run conformance

import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, withCopy } from "./reference.mjs";

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "cases");
const failed = [];
const names = readdirSync(casesDir).sort();
for (const name of names) {
  const dir = join(casesDir, name);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  let actual;
  try {
    actual = withCopy(dir, (copy) => runCase(copy));
  } catch (e) {
    actual = { crashed: String(e) };
  }
  if (!isDeepStrictEqual(actual, expected)) {
    failed.push(name);
    console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected).slice(0, 400)}\n  actual   ${JSON.stringify(actual).slice(0, 400)}`);
  }
}
console.log(`${names.length - failed.length}/${names.length} conformance cases passed (TypeScript)`);
process.exit(failed.length ? 1 : 0);

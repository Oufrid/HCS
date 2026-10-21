import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAnchor, checkDocument, hashLines, normalizeLines, seal, SourceCache } from "../src/anchors.js";
import { findPathReferences } from "../src/audit.js";
import { parse, serialize, HcsSyntaxError } from "../src/format.js";
import { estimateTokens, renderContext, selectClaims } from "../src/render.js";
import { chunkFile, collectSources, globToRegExp, locateQuote } from "../src/sources.js";
import { parseConversation, toTranscript } from "../src/snapshot.js";
import { FIXTURE, tempProject } from "./helpers.js";

const SAMPLE = `HCS/0.1
@title Demo
@root .
@meta owner="team a" kind=code

[claims]
## Overview
#c1[overview,i5] Fees are computed from weight.
  > src/rates.ts:4-7
  > docs/policy.md
#c2[manual] Refunds within 14 days.
  | Opened software excluded.
  > docs/policy.md:3-4

[probes]
?p1 What is the base fee?
  = 25
  > src/rates.ts:2
  ~ c1

[certificates]
!score model=fake:model fidelity=0.900 digest=abc date=2026-01-01T00:00:00Z
`;

test("parse and serialize round-trip", () => {
  const doc = parse(SAMPLE);
  assert.equal(doc.headers.title, "Demo");
  assert.deepEqual(doc.meta, { owner: "team a", kind: "code" });
  assert.equal(doc.claims.length, 2);
  assert.deepEqual(doc.claims[0].tags, ["overview", "i5"]);
  assert.equal(doc.claims[0].section, "Overview");
  assert.deepEqual(doc.claims[0].anchors[0], { path: "src/rates.ts", start: 4, end: 7 });
  assert.deepEqual(doc.claims[0].anchors[1], { path: "docs/policy.md" });
  assert.equal(doc.claims[1].text, "Refunds within 14 days. Opened software excluded.");
  assert.equal(doc.probes[0].answer, "25");
  assert.deepEqual(doc.probes[0].claims, ["c1"]);
  assert.equal(doc.certificates[0].fields.fidelity, "0.900");
  const again = parse(serialize(doc));
  assert.deepEqual(again, doc);
});

test("parse rejects malformed files with line numbers", () => {
  assert.throws(() => parse("[claims]\n"), /missing "HCS\/0.3"/);
  assert.throws(() => parse("HCS/9.0\n"), /unsupported version/);
  assert.throws(() => parse("HCS/0.1\n[claims]\n#a x\n#a y\n"), (e: unknown) => e instanceof HcsSyntaxError && e.line === 4);
  assert.throws(() => parse("HCS/0.1\n[claims]\n#a x\n  > f.ts:9-3\n"), /invalid line range/);
  assert.throws(() => parse("HCS/0.1\n[probes]\n?p1 q\n"), /no "= expected answer"/);
  assert.throws(() => parse("HCS/0.1\n[claims]\n  > f.ts\n"), /outside of a claim/);
});

test("anchors: seal, ok, moved, stale, missing", () => {
  const dir = tempProject(FIXTURE);
  const doc = parse(SAMPLE);
  const cache = () => new SourceCache(dir);
  assert.equal(checkAnchor(doc.claims[0].anchors[0], cache()).status, "unsealed");
  const r = seal(doc, cache());
  assert.equal(r.sealed, 4);
  assert.ok(checkDocument(doc, cache()).every((x) => x.status === "ok"));

  // Insert lines above: the anchored text moved but is unchanged.
  const rates = join(dir, "src/rates.ts");
  writeFileSync(rates, "// header\n// more\n" + FIXTURE["src/rates.ts"]);
  const moved = checkAnchor(doc.claims[0].anchors[0], cache());
  assert.equal(moved.status, "moved");
  assert.deepEqual(moved.relocated, { start: 6, end: 9 });
  assert.equal(seal(doc, cache()).relocated, 2);
  assert.equal(checkAnchor(doc.claims[0].anchors[0], cache()).status, "ok");

  // Change the logic: stale.
  writeFileSync(rates, readFileSync(rates, "utf8").replace("weightKg * 4", "weightKg * 5"));
  assert.equal(checkAnchor(doc.claims[0].anchors[0], cache()).status, "stale");
  assert.equal(checkAnchor(doc.probes[0].anchors[0], cache()).status, "ok");
  assert.equal(seal(doc, cache(), { rehash: true }).rehashed, 1);
  assert.equal(checkAnchor(doc.claims[0].anchors[0], cache()).status, "ok");

  // Whitespace-only and line-ending changes do not break hashes.
  const policy = join(dir, "docs/policy.md");
  writeFileSync(policy, FIXTURE["docs/policy.md"].replace(/\n/g, "  \r\n") + "\n\n");
  assert.ok(checkDocument(doc, cache()).every((x) => x.status === "ok"));

  rmSync(policy);
  const reports = checkDocument(doc, cache());
  assert.equal(reports.find((x) => x.id === "c2")!.status, "missing");
  rmSync(dir, { recursive: true });
});

test("hashing normalizes whitespace at line ends only", () => {
  assert.equal(hashLines(normalizeLines("a \r\nb\n\n")), hashLines(["a", "b"]));
  assert.notEqual(hashLines(["a b"]), hashLines(["a  b"]));
});

test("render drops stale claims, marks kept ones, respects budget and importance", () => {
  const doc = parse(SAMPLE);
  const status = new Map([["c1", "stale" as const]]);
  const out = renderContext(doc, { status });
  assert.ok(!out.includes("c1:"));
  assert.ok(out.includes("c2: Refunds within 14 days. Opened software excluded. (docs/policy.md:3-4)"));
  assert.ok(renderContext(doc, { status, keepStale: true }).includes("(unverified)"));

  const many = parse(
    "HCS/0.1\n[claims]\n" +
      Array.from({ length: 30 }, (_, i) => `#c${i + 1}[i${i === 17 ? 5 : 1}] Claim number ${i + 1} with some words in it.`).join("\n"),
  );
  const sel = selectClaims(many, { budget: 40 });
  assert.equal(sel[0].id, "c18", "highest importance first");
  assert.ok(estimateTokens(renderContext(many, { budget: 40 })) <= 40);
  assert.ok(sel.length < 30);
});

test("chunking, quote location and ignore globs", () => {
  const text = Array.from({ length: 600 }, (_, i) => (i % 50 === 48 ? "" : `line ${i + 1}`)).join("\n");
  const chunks = chunkFile("a.txt", text, 250);
  assert.equal(chunks[0].start, 1);
  assert.equal(chunks.at(-1)!.end, 600);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].start, chunks[i - 1].end + 1);
  assert.ok(chunks.every((c) => c.lines.length <= 250));

  const c = chunkFile("x.ts", "function f() {\n  return   1 +\n    2;\n}\n")[0];
  assert.deepEqual(locateQuote(c, "return 1 + 2;"), { start: 2, end: 3 });
  assert.equal(locateQuote(c, "return 3"), null);

  // Real Gemini quotes of README.md dropped the Markdown markup; the words still have to match.
  const md = chunkFile("README.md", "# T\n\n- **Fidelity** comes with a 95% bootstrap CI.\n\n`hcs serve project.hcs` is a [Model Context Protocol](https://modelcontextprotocol.io) server.\nIt\u2019s \u201cfast\u201d.\n")[0];
  assert.deepEqual(locateQuote(md, "Fidelity comes with a 95% bootstrap CI."), { start: 3, end: 3 });
  assert.deepEqual(locateQuote(md, "hcs serve project.hcs is a Model Context Protocol server."), { start: 5, end: 5 });
  assert.deepEqual(locateQuote(md, `It's "fast".`), { start: 6, end: 6 });
  assert.equal(locateQuote(md, "Fidelity comes with a 99% bootstrap CI."), null, "words must still match");

  assert.ok(globToRegExp("*.lock").test("deep/dir/yarn.lock"));
  assert.ok(globToRegExp("node_modules/").test("a/node_modules/x.js"));
  assert.ok(globToRegExp("/src/gen/**").test("src/gen/a/b.ts"));
  assert.ok(!globToRegExp("/src/gen/**").test("lib/src/gen/a.ts"));
});

test("collectSources honors .hcsignore and skips binaries", () => {
  const dir = tempProject({ ...FIXTURE, ".hcsignore": "docs/\n", "bin.dat": "\0\0\0", "x.hcs": "HCS/0.1\n" });
  assert.deepEqual(collectSources(dir), [".hcsignore", "src/rates.ts"]);
  assert.deepEqual(collectSources(dir, ["src"]), ["src/rates.ts"]);
  rmSync(dir, { recursive: true });
});

test("conversation formats", () => {
  const a = parseConversation([{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }]);
  assert.deepEqual(a, [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
  const b = parseConversation({ messages: [{ role: "system", content: "x" }, { role: "user", content: "q" }] });
  assert.deepEqual(b, [{ role: "user", text: "q" }]);
  const c = parseConversation({
    mapping: {
      x: { message: { author: { role: "assistant" }, create_time: 2, content: { parts: ["second"] } } },
      y: { message: { author: { role: "user" }, create_time: 1, content: { parts: ["first"] } } },
      z: { message: null },
    },
  });
  assert.deepEqual(c.map((m) => m.text), ["first", "second"]);
  assert.ok(toTranscript(a, "T").startsWith("<!-- hcs:transcript -->\n# T"));
  assert.throws(() => parseConversation({ foo: 1 }), /unrecognized/);
});

test("audit finds broken file references", () => {
  const dir = tempProject(FIXTURE);
  const refs = findPathReferences(
    "See `src/rates.ts` and [policy](docs/policy.md#refunds).\nOld: `src/legacy/old.ts:10`, `NOTES.md`. Not paths: `npm test`, `v1.2.3`, `obj.method`, `.md`, https://x.y/z",
    dir,
  );
  assert.deepEqual(
    refs.map((r) => [r.path, r.exists, r.bare]),
    [["src/rates.ts", true, false], ["docs/policy.md", true, false], ["src/legacy/old.ts", false, false], ["NOTES.md", false, true]],
  );
  rmSync(dir, { recursive: true });
});

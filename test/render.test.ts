import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/format.js";
import { compactOrder, contextDigest, estimateTokens, renderContext, selectClaims } from "../src/render.js";
import { certificateIsCurrent, certificateRender, hashForCertificate } from "../src/score.js";

// Three files; the first one has many important claims, as the README often does after compiling.
const DOC = `HCS/0.3
@title t
[claims]
## Overview
#c1[overview,i5] The system has three parts.
  > a.md:1
  > b.ts:1
#c2[overview,i5] Requests flow from b to c.
  > b.ts:2
  > c.py:1
## docs
#c3[i5] First fact from the readme.
  > a.md:2
#c4[i5] Second fact from the readme.
  > a.md:3
#c5[i5] Third fact from the readme.
  > a.md:4
#c6[i5] Fourth fact from the readme.
  > a.md:5
## src
#c7[i4] The retry limit is 2.
  > b.ts::retry
#c8[i3] Timeouts default to 10 seconds.
  > b.ts::timeout
#c9[i3] Tokens are signed with HMAC.
  > c.py::sign
#c10[manual] Never log secrets.
  > c.py:1
`;

test("compact order: hand-written first, then one claim per file in turn, overview claims as one group", () => {
  const doc = parse(DOC);
  const order = compactOrder(doc.claims).map((x) => x.c.id);
  assert.deepEqual(order, ["c10", "c1", "c3", "c7", "c9", "c2", "c4", "c8", "c5", "c6"]);
});

test("under a budget, compact covers every file while full spends the budget on the first file", () => {
  const doc = parse(DOC);
  const budget = 80;
  const full = selectClaims(doc, { budget }).map((c) => c.id);
  const compact = selectClaims(doc, { budget, profile: "compact" }).map((c) => c.id);
  const files = (ids: string[]) => new Set(doc.claims.filter((c) => ids.includes(c.id) && !c.tags.includes("overview")).map((c) => c.anchors[0].path));
  assert.ok(files(compact).size === 3, `compact covers a.md, b.ts and c.py: ${compact}`);
  assert.ok(files(full).size < 3, `full stops before the last files: ${full}`);
  assert.ok(compact.length > full.length, "without anchors more claims fit");
  // Output keeps document order, without anchors; within budget.
  const text = renderContext(doc, { budget, profile: "compact" });
  assert.doesNotMatch(text, /\((a\.md|b\.ts|c\.py)/);
  assert.match(text, /^c10: Never log secrets\.$/m);
  assert.ok(estimateTokens(text) <= budget);
  const lines = text.split("\n").filter((l) => /^c\d+:/.test(l)).map((l) => Number(/^c(\d+)/.exec(l)![1]));
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  // Without a budget both profiles keep every claim; compact only drops the anchors.
  assert.equal(selectClaims(doc, { profile: "compact" }).length, doc.claims.length);
  assert.equal(renderContext(doc, { profile: "compact" }), renderContext(doc, { anchors: false }));
});

test("certificates are bound to the render they were scored on", () => {
  const doc = parse(DOC);
  const status = new Map(doc.claims.map((c) => [c.id, "ok" as const]));
  const compact = hashForCertificate(doc, status, 60, "compact");
  assert.equal(compact, contextDigest(doc, 60, "compact"));
  assert.notEqual(compact, hashForCertificate(doc, status, 60), "the profile changes the digest");
  assert.equal(hashForCertificate(doc, status, 60), contextDigest(doc, 60), "full stays the default, as before 0.3");

  assert.equal(certificateIsCurrent(doc, status, { digest: compact, budget: "60", render: "compact" }), true);
  assert.equal(certificateIsCurrent(doc, status, { digest: compact, budget: "60" }), false, "no render field means full");
  assert.equal(certificateIsCurrent(doc, status, { digest: contextDigest(doc, 60), budget: "60" }), true);
  assert.equal(certificateIsCurrent(doc, status, { digest: compact, budget: "60", render: "fancy" }), false, "an unknown profile is never current");
  assert.equal(certificateRender({ render: "fancy" }), undefined);
  assert.deepEqual(certificateRender({ budget: "500" }), { budget: 500, profile: "full" });
});

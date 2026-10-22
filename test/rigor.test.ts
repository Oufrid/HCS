import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, serialize, type HcsDocument, type Probe } from "../src/format.js";
import type { CompletionRequest, LLM } from "../src/llm.js";
import { cohenKappa, compareContexts, findKnownProbes, kneeOf, scoreContext, scoreCurve, scoreDocument } from "../src/score.js";

/** A model scripted by a function of the request. */
class ScriptedLLM implements LLM {
  constructor(public id: string, private reply: (req: CompletionRequest) => string) {}
  async complete(req: CompletionRequest): Promise<string> {
    return this.reply(req);
  }
}

const probe = (id: string, answer: string, tags?: string[]): Probe => ({
  id,
  question: `question ${id}?`,
  answer,
  anchors: [{ path: "a.txt", hash: "000000000000" }],
  claims: [],
  ...(tags ? { tags } : {}),
});

const questionId = (prompt: string) => /question (\w+)\?/.exec(prompt)?.[1] ?? "";
const isJudging = (req: CompletionRequest) => req.prompt.startsWith("Question:");

test("probe tags parse and serialize; the writer emits 0.3 only when needed", () => {
  const text = "HCS/0.3\n@title t\n\n[claims]\n#c1 x\n  > a.txt\n\n[probes]\n?p1[known] Who?\n  = me\n  > a.txt\n?p2 Why?\n  = because\n";
  const doc = parse(text);
  assert.deepEqual(doc.probes[0].tags, ["known"]);
  assert.equal(doc.probes[1].tags, undefined);
  assert.equal(serialize(doc), text);
  delete doc.probes[0].tags;
  assert.match(serialize(doc), /^HCS\/0.2\n/);
  assert.equal(parse(serialize(doc)).probes.length, 2);
  assert.equal(parse("HCS/0.1\n[claims]\n#c1 x\n").claims.length, 1, "older versions are still read");
});

test("Cohen's kappa", () => {
  assert.equal(cohenKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]), 1);
  assert.equal(cohenKappa(["a", "a"], ["a", "a"]), 1);
  // po = 0.5, pe = 0.5 -> 0
  assert.equal(cohenKappa(["a", "a", "b", "b"], ["a", "b", "a", "b"]), 0);
  // Classic 2x2 example: po = 0.7, pe = 0.5 -> 0.4
  const r1 = ["y", "y", "y", "y", "y", "n", "n", "n", "n", "n"];
  const r2 = ["y", "y", "y", "y", "n", "y", "y", "n", "n", "n"];
  assert.ok(Math.abs(cohenKappa(r1, r2) - 0.4) < 1e-9);
});

test("two judges: agreement and kappa are reported, the stricter verdict counts", async () => {
  const probes = [probe("p1", "alpha"), probe("p2", "beta"), probe("p3", "gamma"), probe("p4", "delta")];
  // The answerer never repeats the reference verbatim, so every answer goes to the judges.
  const answerer = new ScriptedLLM("m:answer", (req) => `it is about ${questionId(req.prompt)}`);
  const lenient = new ScriptedLLM("j:lenient", () => '{"verdict":"correct"}');
  const strict = new ScriptedLLM("j:strict", (req) => {
    const id = /Question: question (\w+)\?/.exec(req.prompt)?.[1];
    return id === "p1" || id === "p2" ? '{"verdict":"correct"}' : id === "p3" ? '{"verdict":"partial"}' : '{"verdict":"incorrect"}';
  });
  const s = await scoreContext("ctx", probes, { answerer, judge: [lenient, strict] });
  assert.deepEqual(s.results.map((r) => r.verdict), ["correct", "correct", "partial", "incorrect"]);
  assert.equal(s.fidelity, (1 + 1 + 0.5 + 0) / 4);
  assert.deepEqual(s.judgeAgreement && { judged: s.judgeAgreement.judged, agreement: s.judgeAgreement.agreement }, { judged: 4, agreement: 0.5 });
  // lenient always says correct: pe = 0.5, po = 0.5 -> kappa 0
  assert.equal(s.judgeAgreement?.kappa, 0);

  const one = await scoreContext("ctx", probes, { answerer, judge: lenient });
  assert.equal(one.judgeAgreement, undefined);
  await assert.rejects(scoreContext("ctx", probes, { answerer, judge: [lenient, strict, lenient] }), /at most two judges/);
});

test("probe quality filter: only probes every model answers without context are known", async () => {
  const probes = [probe("p1", "Paris"), probe("p2", "42"), probe("p3", "secret")];
  const modelA = new ScriptedLLM("m:a", (req) => (isJudging(req) ? '{"verdict":"incorrect"}' : { p1: "Paris", p2: "42", p3: "UNKNOWN" }[questionId(req.prompt)]!));
  const modelB = new ScriptedLLM("m:b", (req) => (isJudging(req) ? '{"verdict":"incorrect"}' : { p1: "It is Paris.", p2: "41", p3: "UNKNOWN" }[questionId(req.prompt)]!));
  const known = await findKnownProbes(probes, [modelA, modelB]);
  assert.deepEqual([...known], ["p1"]);
});

test("scoreDocument reports fidelity on novel probes and records judge fields", async () => {
  const doc: HcsDocument = {
    headers: { title: "t", "known-filter": "m:a,m:b" },
    meta: {},
    claims: [{ id: "c1", text: "The answer to p2 is 42.", tags: [], anchors: [] }],
    probes: [probe("p1", "Paris", ["known"]), probe("p2", "42"), probe("p3", "secret")],
    certificates: [],
  };
  const status = new Map([
    ["probe:p1", "ok"],
    ["probe:p2", "ok"],
    ["probe:p3", "ok"],
  ] as const);
  const answerer = new ScriptedLLM("m:answer", (req) =>
    isJudging(req) ? '{"verdict":"incorrect"}' : ({ p1: "Paris", p2: "42", p3: "UNKNOWN" } as Record<string, string>)[questionId(req.prompt)],
  );
  const judgeA = new ScriptedLLM("j:a", () => '{"verdict":"incorrect"}');
  const r = await scoreDocument(doc, new Map(status), { answerer, judge: [judgeA, answerer] });
  assert.deepEqual(r.novel, { fidelity: 0.5, probes: 2 });
  assert.equal(r.certificate.fields.novel, "0.500");
  assert.equal(r.certificate.fields["novel-probes"], "2");
  assert.equal(r.certificate.fields.judge, "j:a,m:answer");
  assert.equal(r.selfJudged, true, "a judge equal to the answerer is self-judging");
  assert.equal(r.certificate.fields["judge-agreement"], undefined, "nothing was judged: all matches or abstentions");
});

test("paired comparison: differences per probe and their bootstrap CI", async () => {
  const probes = Array.from({ length: 10 }, (_, i) => probe(`p${i}`, `fact${i}`));
  // Context A knows probes 0-4, context B knows 0-8.
  const answerer = new ScriptedLLM("m:x", (req) => {
    const id = Number(questionId(req.prompt).slice(1));
    const ctx = req.prompt.split("\n\nQuestion:")[0];
    const knows = ctx === "A" ? id < 5 : ctx === "B" ? id < 9 : false;
    return knows ? `fact${id}` : "UNKNOWN";
  });
  const c = await compareContexts("A", "B", probes, { answerer });
  assert.equal(c.a.fidelity, 0.5);
  assert.equal(c.b.fidelity, 0.9);
  assert.ok(Math.abs(c.difference - 0.4) < 1e-9);
  assert.deepEqual([c.better, c.worse, c.same], [4, 0, 6]);
  assert.ok(c.ci95[0] > 0 && c.ci95[1] <= 1, `CI ${c.ci95}`);

  const same = await compareContexts("A", "A", probes, { answerer });
  assert.deepEqual(same.ci95, [0, 0]);
  const none = await compareContexts(null, "B", probes, { answerer });
  assert.equal(none.a.fidelity, 0);
});

test("kneeOf: smallest budget within the 95% CI of the best fidelity", () => {
  const pts = [
    { budget: 250, fidelity: 0.2, ci95: [0.1, 0.3] as [number, number] },
    { budget: 1000, fidelity: 0.62, ci95: [0.5, 0.75] as [number, number] },
    { budget: 500, fidelity: 0.45, ci95: [0.3, 0.6] as [number, number] },
    { budget: 2000, fidelity: 0.65, ci95: [0.55, 0.78] as [number, number] },
  ];
  assert.deepEqual(kneeOf(pts), { knee: 1000, best: 2000, flat: false });
  assert.deepEqual(kneeOf([]), {});
  assert.deepEqual(kneeOf([{ budget: 9, fidelity: 0, ci95: [0, 0] }]), { knee: 9, best: 9, flat: false });
  // Real local curve: 0% up to 2000 tokens, 8.1% [0-18.9%] at full context: flat, the knee is uninformative.
  const local = [250, 500, 1000, 2000].map((budget) => ({ budget, fidelity: 0, ci95: [0, 0] as [number, number] }));
  assert.deepEqual(kneeOf([...local, { budget: 8000, fidelity: 0.081, ci95: [0, 0.189] }]), { knee: 250, best: 8000, flat: true });
});

test("scoreCurve: one score per distinct context, certificates per budget with curve id and knee", async () => {
  // Ten claims of importance 5..1 (two each); probe pN is answerable only when claim cN is in the context.
  const doc: HcsDocument = {
    headers: { title: "t" },
    meta: {},
    claims: Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      text: `Fact number ${i} is value${i}.`,
      tags: [`i${5 - Math.floor(i / 2)}`],
      anchors: [],
    })),
    probes: Array.from({ length: 10 }, (_, i) => probe(`p${i}`, `value${i}`)),
    certificates: [],
  };
  const status = new Map(doc.probes.map((p) => [`probe:${p.id}`, "ok"] as const));
  let asked = 0;
  const answerer = new ScriptedLLM("m:a", (req) => {
    asked++;
    const i = Number(questionId(req.prompt).slice(1));
    return req.prompt.includes(`value${i}.`) ? `value${i}` : "UNKNOWN";
  });
  const curve = await scoreCurve(doc, new Map(status), [10000, 30, 60, 5000], { answerer, judge: new ScriptedLLM("j:x", () => '{"verdict":"incorrect"}') });
  assert.deepEqual(curve.points.map((p) => p.budget), [30, 60, 5000, 10000]);
  assert.equal(curve.points[3].sameAs, 5000, "a budget above the full context reuses its result");
  assert.equal(asked, 30, "three distinct contexts x ten probes; the fourth budget costs nothing");
  const fid = curve.points.map((p) => p.score.withContext.fidelity);
  assert.ok(fid[0] < fid[1] && fid[1] < fid[2] && fid[2] === 1, fid.join(","));
  assert.equal(curve.best, 5000);
  assert.equal(curve.knee, 5000);
  for (const p of curve.points) {
    assert.equal(p.score.certificate.fields.budget, String(p.budget));
    assert.equal(p.score.certificate.fields.knee, "5000");
    assert.equal(p.score.certificate.fields.curve, curve.points[0].score.certificate.fields.curve);
  }
  assert.equal(curve.points[3].score.certificate.fields.digest, curve.points[2].score.certificate.fields.digest);
});

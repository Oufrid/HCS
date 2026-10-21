import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, serialize, type HcsDocument, type Probe } from "../src/format.js";
import type { CompletionRequest, LLM } from "../src/llm.js";
import { cohenKappa, compareContexts, findKnownProbes, scoreContext, scoreDocument } from "../src/score.js";

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

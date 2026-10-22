import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { seal, SourceCache } from "../src/anchors.js";
import { parse, type HcsDocument } from "../src/format.js";
import { QuotaError, type CompletionRequest, type LLM } from "../src/llm.js";
import { refine, refineStore, splitHoldout } from "../src/refine.js";
import { tempProject } from "./helpers.js";

class ScriptedLLM implements LLM {
  calls: CompletionRequest[] = [];
  constructor(public id: string, private reply: (req: CompletionRequest) => string) {}
  async complete(req: CompletionRequest): Promise<string> {
    this.calls.push(req);
    return this.reply(req);
  }
}

const N = 10;
const FACTS = Array.from({ length: N }, (_, i) => `key${i} = value${i}`).join("\n") + "\n";
const NOISE = "colour = blue\nshape = round\n";

function project(): { dir: string; doc: HcsDocument } {
  const dir = tempProject({ "facts.txt": FACTS, "notes/noise.txt": NOISE });
  const probes = Array.from({ length: N }, (_, i) => `?p${i} What is key${i}?\n  = value${i}\n  > facts.txt:${i + 1}`).join("\n");
  const doc = parse(
    `HCS/0.2\n@title t\n[claims]\n## (root)\n#c1 key0 is value0.\n  > facts.txt:1\n## notes\n#c2 The colour is blue.\n  > notes/noise.txt:1\n#c3 The shape is round.\n  > notes/noise.txt:2\n[probes]\n${probes}\n`,
  );
  seal(doc, new SourceCache(dir));
  return { dir, doc };
}

/** Answers from the context only; writes, for a gap about keyN, a verified claim plus an invented one. */
function model(useful = true) {
  return new ScriptedLLM("scripted:m", (req) => {
    const gap = /Question the context could not answer: What is (key\d+)\?/.exec(req.prompt);
    if (gap) {
      const k = gap[1];
      const v = k.replace("key", "value");
      return JSON.stringify({
        claims: [
          useful ? { text: `${k} is ${v}.`, quote: `${k} = ${v}`, importance: 4 } : { text: `There is a ${k}.`, quote: `${k} =`, importance: 2 },
          { text: "Invented.", quote: "not in the source", importance: 5 },
        ],
      });
    }
    const q = /Question: What is (key\d+)\?/.exec(req.prompt);
    if (q) {
      const m = new RegExp(`${q[1]} is (value\\d+)`).exec(req.prompt);
      return m ? m[1] : "UNKNOWN";
    }
    return "UNKNOWN";
  });
}

test("refine fills training gaps with verified claims and measures them on held-out probes it never saw", async () => {
  const { dir, doc } = project();
  try {
    const llm = model();
    const r = await refine(doc, { cache: new SourceCache(dir), llm, holdout: 0.3 });
    assert.equal(r.holdoutIds.length, 3);
    const held = new Set(r.holdoutIds);
    // The writer was never asked about a held-out probe.
    const gapPrompts = llm.calls.filter((c) => c.prompt.startsWith("Question the context could not answer"));
    assert.ok(gapPrompts.length > 0);
    for (const id of held) assert.ok(!gapPrompts.some((c) => c.prompt.includes(`What is key${id.slice(1)}?`)), `held-out ${id} leaked`);

    // Training: every gap filled in one round; invented claims rejected by quote verification.
    assert.equal(r.after.train.fidelity, 1);
    assert.ok(r.before.train.fidelity < 0.2);
    assert.equal(r.rounds[0].accepted, true);
    assert.equal(r.rounds[0].rejected, r.rounds[0].added, "one invented claim per gap, all rejected");
    assert.ok(!r.doc.claims.some((c) => c.text === "Invented."));
    assert.equal(r.stopped, "every training probe is answered");
    // New claims are anchored and placed in their file's section, with fresh ids.
    const added = r.doc.claims.filter((c) => !doc.claims.some((o) => o.id === c.id));
    assert.equal(added.length, N - 3 - (held.has("p0") ? 0 : 1));
    assert.ok(added.every((c) => c.section === "(root)" && c.anchors[0].path === "facts.txt" && c.anchors[0].hash));
    // Held-out: claims written for other keys do not answer these questions, and the report shows it.
    assert.equal(r.after.holdout!.fidelity, r.before.holdout!.fidelity);
    // The split is recorded and reused.
    assert.deepEqual(r.doc.headers.holdout.split(",").sort(), [...held].sort());
    assert.deepEqual([...splitHoldout(doc.probes, 0.5, r.doc.headers.holdout)].sort(), [...held].sort());
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refine keeps nothing that does not raise training fidelity; --prune drops sections the probes do not need", async () => {
  const { dir, doc } = project();
  try {
    const r = await refine(doc, { cache: new SourceCache(dir), llm: model(false), holdout: 0.3 });
    assert.equal(r.rounds.length, 1);
    assert.equal(r.rounds[0].accepted, false);
    assert.equal(r.stopped, "the last round did not improve training fidelity");
    assert.deepEqual(r.doc.claims, doc.claims);

    const pruned = await refine(doc, { cache: new SourceCache(dir), llm: model(), holdout: 0.3, prune: true });
    assert.deepEqual(pruned.pruned.sort(), ["c2", "c3"]);
    assert.ok(!pruned.doc.claims.some((c) => c.section === "notes"));
    assert.equal(pruned.after.train.fidelity, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refine needs enough verified probes", async () => {
  const { dir, doc } = project();
  try {
    doc.probes = doc.probes.slice(0, 3);
    await assert.rejects(refine(doc, { cache: new SourceCache(dir), llm: model() }), /at least 4 verified probes/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a run stopped by a quota resumes from its saved results without repeating requests", async () => {
  const { dir, doc } = project();
  try {
    const full = model();
    const reference = await refine(doc, { cache: new SourceCache(dir), llm: full, holdout: 0.3 });
    const data = {};
    const store = refineStore(data, () => {});
    // First run: the provider stops answering after 12 requests.
    let budget = 12;
    const first = model();
    const limited: LLM = { id: first.id, complete: async (req) => (budget-- > 0 ? first.complete(req) : Promise.reject(new QuotaError("daily quota"))) };
    const stopped = await refine(doc, { cache: new SourceCache(dir), llm: limited, holdout: 0.3, store });
    assert.match(stopped.stopped, /^quota/);
    // Second run, same store: same result as an uninterrupted run, and the 12 answered requests are not repeated.
    const second = model();
    const resumed = await refine(doc, { cache: new SourceCache(dir), llm: second, holdout: 0.3, store });
    assert.equal(resumed.stopped, reference.stopped);
    assert.deepEqual(resumed.doc, reference.doc);
    assert.equal(second.calls.length, full.calls.length - 12);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

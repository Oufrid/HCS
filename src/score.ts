// Fidelity scoring: how much of the source can a model recover from the context alone?

import type { Certificate, HcsDocument, Probe } from "./format.js";
import { extractJSON, mapLimit, type LLM } from "./llm.js";
import { contextDigest, DECODER_PROMPT, estimateTokens, renderContext } from "./render.js";
import type { AnchorStatus } from "./anchors.js";

export type Verdict = "correct" | "partial" | "incorrect" | "unknown";

export interface ProbeResult {
  id: string;
  question: string;
  expected: string;
  /** Answer from the first run (all runs are graded). */
  answer: string;
  /** Verdict of the first run. */
  verdict: Verdict;
  /** How the first verdict was reached: deterministic match, the judge model, or an abstention. */
  by: "match" | "judge" | "abstain";
  /** Verdicts of every run. */
  verdicts: Verdict[];
  /** Mean points over runs. */
  points: number;
}

export interface ScoreSummary {
  /** Mean points over probes: correct = 1, partial = 0.5, otherwise 0. */
  fidelity: number;
  /** 95% bootstrap confidence interval of `fidelity` over probes. */
  ci95: [number, number];
  /** Share of answers that were wrong instead of abstaining: the context misled the model. */
  misled: number;
  /** Share of answers where the model declined to answer. */
  abstained: number;
  probes: number;
  runs: number;
  results: ProbeResult[];
}

const POINTS: Record<Verdict, number> = { correct: 1, partial: 0.5, incorrect: 0, unknown: 0 };

function norm(s: string): string {
  return s.toLowerCase().replace(/[`'"*_]/g, "").replace(/\s+/g, " ").trim();
}

async function answer(llm: LLM, question: string, context: string | null): Promise<string> {
  const instructions =
    'Answer in at most two sentences. If you cannot answer from what you were given, reply exactly "UNKNOWN".';
  if (context === null) {
    return llm.complete({
      system: "Answer the question from your own knowledge. Do not guess.",
      prompt: `${question}\n\n${instructions}`,
      maxTokens: 300,
    });
  }
  return llm.complete({
    system: DECODER_PROMPT,
    prompt: `${context}\n\nQuestion: ${question}\n\n${instructions} Answer only from the context above; do not read or assume anything else.`,
    maxTokens: 300,
  });
}

async function judge(llm: LLM, p: Probe, candidate: string): Promise<Verdict> {
  const reply = await llm.complete({
    system:
      "You grade answers against a reference answer taken from the source material. Be strict about facts (names, numbers, behavior) and lenient about wording. Reply with JSON only.",
    prompt: `Question: ${p.question}
Reference answer: ${p.answer}
Candidate answer: ${candidate}

"correct": states the reference facts without contradicting them.
"partial": some reference facts are right, others missing; nothing contradicts the reference.
"incorrect": contradicts the reference, or the essential fact is wrong or missing.

Return {"verdict":"correct"|"partial"|"incorrect"}`,
    maxTokens: 50,
  });
  try {
    const v = extractJSON<{ verdict?: string }>(reply).verdict;
    if (v === "correct" || v === "partial" || v === "incorrect") return v;
  } catch {
    // fall through
  }
  const m = /\b(correct|partial|incorrect)\b/i.exec(reply);
  return m ? (m[1].toLowerCase() as Verdict) : "incorrect";
}

export interface ScoreOptions {
  answerer: LLM;
  judge?: LLM;
  concurrency?: number;
  /** Ask every probe this many times; model outputs vary even at temperature 0. Default 1. */
  runs?: number;
  onProgress?: (msg: string) => void;
}

/** Deterministic PRNG so confidence intervals are reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap of the mean. With few probes the interval is wide, and it should be. */
export function bootstrapCI(values: number[], resamples = 2000, seed = 42): [number, number] {
  if (!values.length) return [0, 0];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)], means[Math.ceil(resamples * 0.975) - 1]];
}

/** Score any context (an .hcs render, an AGENTS.md, a summary, or `null` for no context) against probes. */
export async function scoreContext(context: string | null, probes: Probe[], opts: ScoreOptions): Promise<ScoreSummary> {
  const j = opts.judge ?? opts.answerer;
  const runs = Math.max(1, Math.floor(opts.runs ?? 1));
  let done = 0;
  const grade = async (p: Probe): Promise<{ raw: string; verdict: Verdict; by: ProbeResult["by"] }> => {
    const raw = (await answer(opts.answerer, p.question, context)).trim();
    if (raw === "" || /^\W*unknown\b/i.test(raw)) return { raw, verdict: "unknown", by: "abstain" };
    if (norm(p.answer).length >= 2 && norm(raw).includes(norm(p.answer))) return { raw, verdict: "correct", by: "match" };
    return { raw, verdict: await judge(j, p, raw), by: "judge" };
  };
  const results = await mapLimit(probes, opts.concurrency ?? 4, async (p): Promise<ProbeResult> => {
    const graded = [];
    for (let r = 0; r < runs; r++) graded.push(await grade(p));
    const verdicts = graded.map((g) => g.verdict);
    opts.onProgress?.(`[${++done}/${probes.length}] ${p.id} ${verdicts.join(",")}`);
    return {
      id: p.id,
      question: p.question,
      expected: p.answer,
      answer: graded[0].raw,
      verdict: graded[0].verdict,
      by: graded[0].by,
      verdicts,
      points: verdicts.reduce((s, v) => s + POINTS[v], 0) / runs,
    };
  });
  const n = results.length || 1;
  const share = (v: Verdict) => results.reduce((s, r) => s + r.verdicts.filter((x) => x === v).length / runs, 0) / n;
  const points = results.map((r) => r.points);
  return {
    fidelity: points.reduce((a, b) => a + b, 0) / n,
    ci95: bootstrapCI(points),
    misled: share("incorrect"),
    abstained: share("unknown"),
    probes: results.length,
    runs,
    results,
  };
}

export interface DocumentScore {
  withContext: ScoreSummary;
  baseline?: ScoreSummary;
  /**
   * Fidelity on the probes the model could NOT answer without context (requires a baseline).
   * This isolates what the context actually taught the model.
   */
  informative?: { fidelity: number; probes: number };
  /** True when the answering model also graded its own answers. */
  selfJudged: boolean;
  skippedProbes: string[];
  contextTokens: number;
  certificate: Certificate;
}

export async function scoreDocument(
  doc: HcsDocument,
  status: Map<string, AnchorStatus>,
  opts: ScoreOptions & { budget?: number; baseline?: boolean },
): Promise<DocumentScore> {
  const usable = doc.probes.filter((p) => {
    const s = status.get(`probe:${p.id}`);
    return s === "ok" || s === "moved";
  });
  if (!usable.length) throw new Error("no verified probes to score with (run `hcs check`; stale probes are skipped)");
  const claimStatus = new Map([...status].filter(([k]) => k.startsWith("claim:")).map(([k, v]) => [k.slice(6), v]));
  const context = renderContext(doc, { status: claimStatus, budget: opts.budget });
  const withContext = await scoreContext(context, usable, opts);
  const baseline = opts.baseline ? await scoreContext(null, usable, { ...opts, onProgress: undefined }) : undefined;
  const contextTokens = estimateTokens(context);

  let informative: DocumentScore["informative"];
  if (baseline) {
    const unknownBefore = new Set(baseline.results.filter((r) => r.points === 0).map((r) => r.id));
    const subset = withContext.results.filter((r) => unknownBefore.has(r.id));
    informative = { fidelity: subset.length ? subset.reduce((s, r) => s + r.points, 0) / subset.length : 0, probes: subset.length };
  }

  const fields: Record<string, string> = {
    model: opts.answerer.id,
    judge: (opts.judge ?? opts.answerer).id,
    fidelity: withContext.fidelity.toFixed(3),
    ci95: `${withContext.ci95[0].toFixed(3)}-${withContext.ci95[1].toFixed(3)}`,
  };
  if (baseline) fields.baseline = baseline.fidelity.toFixed(3);
  if (informative) {
    fields.informative = informative.fidelity.toFixed(3);
    fields["informative-probes"] = String(informative.probes);
  }
  if (withContext.runs > 1) fields.runs = String(withContext.runs);
  fields.misled = withContext.misled.toFixed(3);
  fields.probes = String(withContext.probes);
  fields.tokens = String(contextTokens);
  if (opts.budget !== undefined) fields.budget = String(opts.budget);
  fields.digest = hashForCertificate(doc, claimStatus, opts.budget);
  fields.date = new Date().toISOString();

  return {
    withContext,
    baseline,
    informative,
    selfJudged: !opts.judge || opts.judge.id === opts.answerer.id,
    skippedProbes: doc.probes.filter((p) => !usable.includes(p)).map((p) => p.id),
    contextTokens,
    certificate: { fields },
  };
}

/**
 * A certificate is valid only for the exact context that was scored. Stale claims are excluded from that
 * context, so the digest is computed the same way `hcs check` recomputes it.
 */
export function hashForCertificate(doc: HcsDocument, claimStatus: Map<string, AnchorStatus>, budget?: number): string {
  const allFresh = [...claimStatus.values()].every((s) => s === "ok" || s === "moved");
  if (allFresh) return contextDigest(doc, budget);
  const filtered: HcsDocument = {
    ...doc,
    claims: doc.claims.filter((c) => {
      const s = claimStatus.get(c.id);
      return s !== "stale" && s !== "missing";
    }),
  };
  return contextDigest(filtered, budget);
}

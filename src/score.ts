// Fidelity scoring: how much of the source can a model recover from the context alone?

import type { Certificate, HcsDocument, Probe } from "./format.js";
import { extractJSON, mapLimit, type LLM } from "./llm.js";
import { contextDigest, DECODER_PROMPT, estimateTokens, renderContext, selectClaims } from "./render.js";
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
  /** With two judges: both verdicts for each judged answer. */
  judgePairs?: Verdict[][];
}

/** Stores per-probe results so an interrupted score (quota, outage) resumes where it stopped. */
export interface ScoreCache {
  get(id: string): ProbeResult | undefined;
  put(result: ProbeResult): void;
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
  /**
   * With two judges: how often they agreed on the answers they both graded. Exact matches and abstentions are
   * not judged; absent when nothing was.
   */
  judgeAgreement?: JudgeAgreement;
}

export interface JudgeAgreement {
  /** Answers graded by both judges. */
  judged: number;
  /** Share of those answers given the same verdict. */
  agreement: number;
  /** Cohen's kappa over the three verdicts: agreement corrected for chance (1 perfect, 0 chance level). */
  kappa: number;
}

const POINTS: Record<Verdict, number> = { correct: 1, partial: 0.5, incorrect: 0, unknown: 0 };

/** The verdict worth the fewest points: when judges disagree, the stricter one counts. */
function strictest(verdicts: Verdict[]): Verdict {
  return verdicts.reduce((a, b) => (POINTS[b] < POINTS[a] ? b : a));
}

/** Cohen's kappa for two raters over the same items. */
export function cohenKappa(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  const cats = new Set([...a, ...b]);
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  const po = agree / n;
  let pe = 0;
  for (const c of cats) pe += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

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
      maxTokens: 1024,
    });
  }
  return llm.complete({
    system: DECODER_PROMPT,
    prompt: `${context}\n\nQuestion: ${question}\n\n${instructions} Answer only from the context above; do not read or assume anything else.`,
    maxTokens: 1024,
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
    maxTokens: 1024,
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
  /** One judge, or two: then their agreement is reported and the stricter verdict counts. Default: the answerer. */
  judge?: LLM | LLM[];
  concurrency?: number;
  /** Ask every probe this many times; model outputs vary even at temperature 0. Default 1. */
  runs?: number;
  onProgress?: (msg: string) => void;
  /** Results already computed for this exact context, models and settings; new results are added to it. */
  cache?: ScoreCache;
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
  const judges = judgesOf(opts);
  const runs = Math.max(1, Math.floor(opts.runs ?? 1));
  let done = 0;
  const grade = async (p: Probe): Promise<{ raw: string; verdict: Verdict; by: ProbeResult["by"]; pair?: Verdict[] }> => {
    const raw = (await answer(opts.answerer, p.question, context)).trim();
    if (raw === "" || /^\W*unknown\b/i.test(raw)) return { raw, verdict: "unknown", by: "abstain" };
    if (norm(p.answer).length >= 2 && norm(raw).includes(norm(p.answer))) return { raw, verdict: "correct", by: "match" };
    const verdicts: Verdict[] = [];
    for (const j of judges) verdicts.push(await judge(j, p, raw));
    return { raw, verdict: strictest(verdicts), by: "judge", ...(verdicts.length > 1 ? { pair: verdicts } : {}) };
  };
  const results = await mapLimit(probes, opts.concurrency ?? 4, async (p): Promise<ProbeResult> => {
    const cached = opts.cache?.get(p.id);
    if (cached && cached.verdicts.length === runs) {
      opts.onProgress?.(`[${++done}/${probes.length}] ${p.id} ${cached.verdicts.join(",")} (saved earlier)`);
      return cached;
    }
    const graded = [];
    for (let r = 0; r < runs; r++) graded.push(await grade(p));
    const verdicts = graded.map((g) => g.verdict);
    opts.onProgress?.(`[${++done}/${probes.length}] ${p.id} ${verdicts.join(",")}`);
    const pairs = graded.flatMap((g) => (g.pair ? [g.pair] : []));
    const result: ProbeResult = {
      id: p.id,
      question: p.question,
      expected: p.answer,
      answer: graded[0].raw,
      verdict: graded[0].verdict,
      by: graded[0].by,
      verdicts,
      points: verdicts.reduce((s, v) => s + POINTS[v], 0) / runs,
      ...(pairs.length ? { judgePairs: pairs } : {}),
    };
    opts.cache?.put(result);
    return result;
  });
  const pairs = results.flatMap((r) => r.judgePairs ?? []);
  const n = results.length || 1;
  const share = (v: Verdict) => results.reduce((s, r) => s + r.verdicts.filter((x) => x === v).length / runs, 0) / n;
  const points = results.map((r) => r.points);
  const summary: ScoreSummary = {
    fidelity: points.reduce((a, b) => a + b, 0) / n,
    ci95: bootstrapCI(points),
    misled: share("incorrect"),
    abstained: share("unknown"),
    probes: results.length,
    runs,
    results,
  };
  if (judges.length > 1 && pairs.length) {
    const a = pairs.map((v) => v[0]);
    const b = pairs.map((v) => v[1]);
    summary.judgeAgreement = {
      judged: pairs.length,
      agreement: pairs.filter((v) => v[0] === v[1]).length / pairs.length,
      kappa: cohenKappa(a, b),
    };
  }
  return summary;
}

function judgesOf(opts: ScoreOptions): LLM[] {
  const list = opts.judge === undefined ? [opts.answerer] : Array.isArray(opts.judge) ? opts.judge : [opts.judge];
  if (!list.length) return [opts.answerer];
  if (list.length > 2) throw new Error("at most two judges are supported");
  return list;
}

/**
 * Probe quality filter: ask every probe without context to each model. A probe that every model answers
 * correctly measures what models already know, not what the context teaches; the caller tags it `known`.
 */
export async function findKnownProbes(
  probes: Probe[],
  models: LLM[],
  opts: { judge?: LLM; concurrency?: number } = {},
): Promise<Set<string>> {
  let known = new Set(probes.map((p) => p.id));
  for (const m of models) {
    const s = await scoreContext(null, probes, { answerer: m, judge: opts.judge, concurrency: opts.concurrency });
    known = new Set(s.results.filter((r) => known.has(r.id) && r.points === 1).map((r) => r.id));
  }
  return known;
}

/** Paired comparison of two contexts on the same probes: per-probe differences, bootstrapped. */
export interface Comparison {
  a: ScoreSummary;
  b: ScoreSummary;
  /** Mean of (b - a) points per probe. */
  difference: number;
  /** 95% paired bootstrap confidence interval of the difference. */
  ci95: [number, number];
  /** Probes where b scored higher, lower, or the same as a. */
  better: number;
  worse: number;
  same: number;
}

export async function compareContexts(a: string | null, b: string | null, probes: Probe[], opts: ScoreOptions): Promise<Comparison> {
  const sa = await scoreContext(a, probes, { ...opts, cache: undefined });
  const sb = await scoreContext(b, probes, { ...opts, cache: undefined });
  const pa = new Map(sa.results.map((r) => [r.id, r.points]));
  const diffs = sb.results.map((r) => r.points - (pa.get(r.id) ?? 0));
  return {
    a: sa,
    b: sb,
    difference: diffs.reduce((x, y) => x + y, 0) / (diffs.length || 1),
    ci95: bootstrapCI(diffs),
    better: diffs.filter((d) => d > 0).length,
    worse: diffs.filter((d) => d < 0).length,
    same: diffs.filter((d) => d === 0).length,
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
  /** Fidelity on probes not tagged `known` (when the file went through the probe quality filter). */
  novel?: { fidelity: number; probes: number };
  /** True when the answering model also graded its own answers. */
  selfJudged: boolean;
  skippedProbes: string[];
  contextTokens: number;
  certificate: Certificate;
}

export async function scoreDocument(
  doc: HcsDocument,
  status: Map<string, AnchorStatus>,
  opts: ScoreOptions & { budget?: number; baseline?: boolean; baselineCache?: ScoreCache; baselineResult?: ScoreSummary },
): Promise<DocumentScore> {
  const usable = doc.probes.filter((p) => {
    const s = status.get(`probe:${p.id}`);
    return s === "ok" || s === "moved" || s === "review";
  });
  if (!usable.length) throw new Error("no verified probes to score with (run `hcs check`; stale probes are skipped)");
  const claimStatus = new Map([...status].filter(([k]) => k.startsWith("claim:")).map(([k, v]) => [k.slice(6), v]));
  const context = renderContext(doc, { status: claimStatus, budget: opts.budget });
  const withContext = await scoreContext(context, usable, opts);
  const baseline =
    opts.baselineResult ?? (opts.baseline ? await scoreContext(null, usable, { ...opts, onProgress: undefined, cache: opts.baselineCache }) : undefined);
  const contextTokens = estimateTokens(context);

  let informative: DocumentScore["informative"];
  if (baseline) {
    const unknownBefore = new Set(baseline.results.filter((r) => r.points === 0).map((r) => r.id));
    const subset = withContext.results.filter((r) => unknownBefore.has(r.id));
    informative = { fidelity: subset.length ? subset.reduce((s, r) => s + r.points, 0) / subset.length : 0, probes: subset.length };
  }

  let novel: DocumentScore["novel"];
  if (doc.headers["known-filter"] || usable.some((p) => p.tags?.includes("known"))) {
    const knownIds = new Set(usable.filter((p) => p.tags?.includes("known")).map((p) => p.id));
    const subset = withContext.results.filter((r) => !knownIds.has(r.id));
    novel = { fidelity: subset.length ? subset.reduce((s, r) => s + r.points, 0) / subset.length : 0, probes: subset.length };
  }

  const judges = judgesOf(opts);
  const fields: Record<string, string> = {
    model: opts.answerer.id,
    judge: judges.map((j) => j.id).join(","),
    fidelity: withContext.fidelity.toFixed(3),
    ci95: `${withContext.ci95[0].toFixed(3)}-${withContext.ci95[1].toFixed(3)}`,
  };
  if (baseline) fields.baseline = baseline.fidelity.toFixed(3);
  if (informative) {
    fields.informative = informative.fidelity.toFixed(3);
    fields["informative-probes"] = String(informative.probes);
  }
  if (novel) {
    fields.novel = novel.fidelity.toFixed(3);
    fields["novel-probes"] = String(novel.probes);
  }
  const ag = withContext.judgeAgreement;
  if (ag) {
    fields["judge-agreement"] = ag.agreement.toFixed(3);
    fields["judge-kappa"] = ag.kappa.toFixed(3);
    fields.judged = String(ag.judged);
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
    novel,
    selfJudged: judges.some((j) => j.id === opts.answerer.id),
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
  const allFresh = [...claimStatus.values()].every((s) => s === "ok" || s === "moved" || s === "review");
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

export interface CurvePoint {
  budget: number;
  /** Estimated tokens of the context rendered at this budget, and the claims it keeps. */
  tokens: number;
  claims: number;
  score: DocumentScore;
  /** Set when this budget renders exactly the same context as a smaller one, whose result is reused. */
  sameAs?: number;
}

export interface Curve {
  points: CurvePoint[];
  /** Smallest budget whose fidelity reaches the lower bound of the best point's 95% CI. */
  knee?: number;
  best?: number;
  /** No budget is measurably better than the smallest one (see kneeOf). */
  flat?: boolean;
}

/**
 * The knee: smallest budget scoring within the 95% confidence interval of the best one (ties: smallest budget).
 * `flat` means even the smallest budget is within that interval: more context did not measurably help, so the knee
 * says nothing about how much context is needed.
 */
export function kneeOf(points: { budget: number; fidelity: number; ci95: [number, number] }[]): { knee?: number; best?: number; flat?: boolean } {
  if (!points.length) return {};
  const sorted = [...points].sort((a, b) => a.budget - b.budget);
  const best = sorted.reduce((b, p) => (p.fidelity > b.fidelity ? p : b));
  const knee = sorted.find((p) => p.fidelity >= best.ci95[0]);
  return { knee: knee?.budget, best: best.budget, flat: sorted.length > 1 && knee === sorted[0] };
}

/**
 * Fidelity at each token budget, on the same probes. Budgets that render the same context are scored once. With
 * `baseline`, the no-context score is computed once and shared. Every point gets a certificate tagged with the
 * curve id and its knee, so `hcs check` verifies each one like any certificate.
 */
export async function scoreCurve(
  doc: HcsDocument,
  status: Map<string, AnchorStatus>,
  budgets: number[],
  opts: ScoreOptions & { baseline?: boolean; cacheFor?: (budget: number) => { context?: ScoreCache; baseline?: ScoreCache } },
): Promise<Curve> {
  const claimStatus = new Map([...status].filter(([k]) => k.startsWith("claim:")).map(([k, v]) => [k.slice(6), v]));
  const curveId = new Date().toISOString();
  const byDigest = new Map<string, CurvePoint>();
  const points: CurvePoint[] = [];
  let baseline: ScoreSummary | undefined;
  for (const budget of [...new Set(budgets)].sort((a, b) => a - b)) {
    const context = renderContext(doc, { status: claimStatus, budget });
    const digest = hashForCertificate(doc, claimStatus, budget);
    const claims = selectClaims(doc, { status: claimStatus, budget }).length;
    const earlier = byDigest.get(digest);
    if (earlier) {
      const certificate = { fields: { ...earlier.score.certificate.fields, budget: String(budget) } };
      points.push({ budget, tokens: earlier.tokens, claims: earlier.claims, score: { ...earlier.score, certificate }, sameAs: earlier.budget });
      continue;
    }
    opts.onProgress?.(`budget ${budget}: ~${estimateTokens(context)} tokens, ${claims} claims`);
    const caches = opts.cacheFor?.(budget) ?? {};
    const score = await scoreDocument(doc, status, { ...opts, budget, baseline: opts.baseline && !baseline, baselineResult: baseline, cache: caches.context, baselineCache: caches.baseline });
    baseline ??= score.baseline;
    const point = { budget, tokens: score.contextTokens, claims, score };
    byDigest.set(digest, point);
    points.push(point);
  }
  const { knee, best, flat } = kneeOf(points.map((p) => ({ budget: p.budget, fidelity: p.score.withContext.fidelity, ci95: p.score.withContext.ci95 })));
  for (const p of points) {
    p.score.certificate.fields.curve = curveId;
    if (knee !== undefined) p.score.certificate.fields.knee = String(knee);
  }
  return { points, knee, best, flat };
}


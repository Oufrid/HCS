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
  answer: string;
  verdict: Verdict;
  /** How the verdict was reached: deterministic match or the judge model. */
  by: "match" | "judge" | "abstain";
}

export interface ScoreSummary {
  /** Mean points: correct = 1, partial = 0.5, otherwise 0. */
  fidelity: number;
  /** Share of probes answered wrongly instead of abstaining: the context misled the model. */
  misled: number;
  /** Share of probes the model declined to answer. */
  abstained: number;
  probes: number;
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
  onProgress?: (msg: string) => void;
}

/** Score any context (an .hcs render, an AGENTS.md, a summary, or `null` for no context) against probes. */
export async function scoreContext(context: string | null, probes: Probe[], opts: ScoreOptions): Promise<ScoreSummary> {
  const j = opts.judge ?? opts.answerer;
  let done = 0;
  const results = await mapLimit(probes, opts.concurrency ?? 4, async (p): Promise<ProbeResult> => {
    const raw = (await answer(opts.answerer, p.question, context)).trim();
    let verdict: Verdict;
    let by: ProbeResult["by"];
    if (/^"?unknown"?\.?$/i.test(raw) || raw === "") {
      verdict = "unknown";
      by = "abstain";
    } else if (norm(p.answer).length >= 2 && norm(raw).includes(norm(p.answer))) {
      verdict = "correct";
      by = "match";
    } else {
      verdict = await judge(j, p, raw);
      by = "judge";
    }
    opts.onProgress?.(`[${++done}/${probes.length}] ${p.id} ${verdict}`);
    return { id: p.id, question: p.question, expected: p.answer, answer: raw, verdict, by };
  });
  const n = results.length || 1;
  return {
    fidelity: results.reduce((s, r) => s + POINTS[r.verdict], 0) / n,
    misled: results.filter((r) => r.verdict === "incorrect").length / n,
    abstained: results.filter((r) => r.verdict === "unknown").length / n,
    probes: results.length,
    results,
  };
}

export interface DocumentScore {
  withContext: ScoreSummary;
  baseline?: ScoreSummary;
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

  const fields: Record<string, string> = {
    model: opts.answerer.id,
    judge: (opts.judge ?? opts.answerer).id,
    fidelity: withContext.fidelity.toFixed(3),
  };
  if (baseline) fields.baseline = baseline.fidelity.toFixed(3);
  fields.misled = withContext.misled.toFixed(3);
  fields.probes = String(withContext.probes);
  fields.tokens = String(contextTokens);
  if (opts.budget !== undefined) fields.budget = String(opts.budget);
  fields.digest = hashForCertificate(doc, claimStatus, opts.budget);
  fields.date = new Date().toISOString();

  return {
    withContext,
    baseline,
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

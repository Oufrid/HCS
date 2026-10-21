#!/usr/bin/env node
// hcs: command-line interface for the Holographic Context Standard.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkDocument, insideRoot, rootDir, seal, SourceCache, type AnchorStatus, type ItemReport } from "./anchors.js";
import { findPathReferences } from "./audit.js";
import { baseDocument, COMMENT_MARKER, gitChanges, gitPrefix, impact, impactMarkdown } from "./impact.js";
import { githubContext, upsertComment } from "./github.js";
import { injectionFindings, type SourceFinding } from "./guard.js";
import { compile } from "./compile.js";
import { emptyDocument, formatAnchor, HcsSyntaxError, parse, serialize, type HcsDocument } from "./format.js";
import { createLLM, listModels, QuotaError, type LLM } from "./llm.js";
import { DECODER_PROMPT, estimateTokens, renderContext, selectClaims } from "./render.js";
import { compareContexts, findKnownProbes, hashForCertificate, scoreContext, scoreCurve, scoreDocument, type ProbeResult, type ScoreCache, type ScoreSummary } from "./score.js";
import { serveStdio } from "./mcp.js";
import { parseConversation, toTranscript } from "./snapshot.js";

const VERSION = "0.2.0";

const HELP = `hcs ${VERSION} - Holographic Context Standard

Verifiable, fidelity-scored context files for any LLM.

Deterministic commands (no LLM, no network; except \`models\`, which asks the provider for its list):
  hcs init [-o project.hcs] [--title T]       Create an empty .hcs file to write claims by hand
  hcs validate <file.hcs>                     Check syntax
  hcs check <file.hcs> [--strict] [--json]    Verify every anchor against the sources; exit 1 if stale
                                              (--strict: also unsealed anchors and suspect claims)
  hcs seal <file.hcs> [--rehash] [--ids a,b]  Fill missing hashes, follow moved anchors
            [--deps]                          (--rehash: accept current content of stale or review anchors;
                                              --deps: also hash what each JS/TS/Python symbol uses, so that
                                              check reports "review" when a dependency changes)
  hcs render <file.hcs> [--budget N]          Print the context block to give an LLM
             [--decoder] [--no-anchors] [--keep-stale]
  hcs stats <file.hcs>                        Sizes, token estimates, compression ratio
  hcs audit <context-file> [--root DIR]       Find broken file references in AGENTS.md, CLAUDE.md...
            [--probes file.hcs --model M]     ...and score it against an .hcs probe set
  hcs serve <file.hcs> [--root DIR]           MCP server (stdio) for any MCP client; source reads stay in the root
            [--allow-write]                   tools: hcs_context, hcs_expand, hcs_search, hcs_verify, hcs_source
                                              (+ hcs_record with --allow-write); resources: hcs://context,
                                              hcs://claim/<id>
  hcs impact <file.hcs> --base <ref>          Claims and probes citing code changed since a git ref
             [--json | --format markdown | --comment] [--link-base URL]
                                              (--comment: post or update the pull-request comment, in Actions)
  hcs models <provider> [--free]              List the model ids your key can use (--free: OpenRouter ":free" models)

LLM commands (--model provider:model, optional --rpm N to stay under free-tier rate limits, optional
--reasoning-effort low|medium|high to limit hidden reasoning on models that support it):
  hcs compile [paths...] --model M [-o project.hcs] [--root DIR] [--title T]
              [--update] [--max-probes N] [--no-synthesize] [--concurrency N]
              [--anchors symbols|lines] [--filter-known M1,M2]
                                              (--filter-known: tag [known] the probes every listed model
                                              answers without context)
  hcs score <file.hcs> --model M [--judge M [--judge M2]] [--budget N] [--baseline] [--runs N] [--write] [--json]
                                              (two judges: agreement is reported, the stricter verdict counts)
  hcs curve <file.hcs> --model M [--judge M] [--budgets 250,500,1000,2000,4000] [--baseline] [--runs N] [--write] [--json]
                                              Fidelity at each token budget and the knee (smallest budget within the
                                              95% CI of the best); --write stores one certificate per budget
  hcs compare <a> <b> --model M [--probes file.hcs] [--judge M] [--budget N] [--runs N] [--json]
                                              Paired comparison of two contexts on the same probes; each side
                                              is an .hcs file (rendered), any text file (AGENTS.md...) or none
  hcs snapshot <conversation.json|.md> --model M [-o session.hcs]

Providers: openai (OPENAI_API_KEY, OPENAI_BASE_URL for any compatible server),
           anthropic (ANTHROPIC_API_KEY), gemini (GEMINI_API_KEY), groq (GROQ_API_KEY),
           openrouter (OPENROUTER_API_KEY), ollama (OLLAMA_HOST)

Exit codes: 0 ok, 1 verification failed, 2 usage or syntax error.`;

class UsageError extends Error {}

function load(file: string): HcsDocument {
  if (!existsSync(file)) throw new UsageError(`file not found: ${file}`);
  return parse(readFileSync(file, "utf8"));
}

function save(file: string, doc: HcsDocument): void {
  writeFileSync(file, serialize(doc));
}

function statusMap(reports: ItemReport[]): Map<string, AnchorStatus> {
  return new Map(reports.map((r) => [`${r.kind}:${r.id}`, r.status]));
}

function claimStatus(reports: ItemReport[]): Map<string, AnchorStatus> {
  return new Map(reports.filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const ICON: Record<AnchorStatus, string> = { ok: "ok", moved: "moved", review: "review", unsealed: "unsealed", stale: "STALE", missing: "MISSING" };

function requireFile(positionals: string[], what = "<file.hcs>"): string {
  if (!positionals[0]) throw new UsageError(`missing ${what}`);
  return positionals[0];
}

function requireModel(v: unknown): string {
  if (typeof v !== "string" || !v) throw new UsageError("missing --model provider:model (e.g. openai:gpt-4o-mini, ollama:llama3.1)");
  return v;
}

function anchorMode(v: string | undefined): "symbols" | "lines" | undefined {
  if (v === undefined || v === "symbols" || v === "lines") return v;
  throw new UsageError('--anchors must be "symbols" or "lines"');
}

function printScore(label: string, s: ScoreSummary): void {
  const ci = `[95% CI ${pct(s.ci95[0])}-${pct(s.ci95[1])}]`;
  console.log(
    `${label.padEnd(16)} fidelity ${pct(s.fidelity).padStart(6)} ${ci}   misled ${pct(s.misled).padStart(6)}   abstained ${pct(s.abstained).padStart(6)}   (${s.probes} probes${s.runs > 1 ? ` x ${s.runs} runs` : ""})`,
  );
}

/**
 * Per-probe score results on disk (`.hcs-cache/` next to the file), keyed by everything that affects them: the
 * context digest, the probes, the models and the settings. A changed input gives a new key, never stale reuse.
 */
function scoreCacheFile(file: string, key: object) {
  const id = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
  const path = join(dirname(resolve(file)), ".hcs-cache", `score-${basename(file)}-${id}.json`);
  const data: { context: Record<string, ProbeResult>; baseline: Record<string, ProbeResult> } = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { context: {}, baseline: {} };
  const count = Object.keys(data.context).length + Object.keys(data.baseline).length;
  let added = 0;
  const store = (part: "context" | "baseline"): ScoreCache => ({
    get: (pid) => data[part][pid],
    put: (r) => {
      data[part][r.id] = r;
      added++;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data));
    },
  });
  return {
    path: relative(process.cwd(), path),
    count,
    added: () => added,
    context: store("context"),
    baseline: store("baseline"),
    remove: () => rmSync(path, { force: true }),
  };
}

function printSourceFindings(found: SourceFinding[]): void {
  if (!found.length) return;
  const high = found.filter((f) => f.severity === "high");
  console.log(`  source scan: ${found.length} line(s) with injection-like text in ${new Set(found.map((f) => f.path)).size} file(s), ${high.length} high risk`);
  const shown = [...high, ...found.filter((f) => f.severity === "low")].slice(0, 20);
  for (const f of shown) console.log(`    ${f.severity === "high" ? "HIGH" : "low "} ${f.path}:${f.line}  ${f.reason}`);
  if (found.length > shown.length) console.log(`    ... and ${found.length - shown.length} more`);
  if (high.length) console.log("  claims quoting such text are tagged suspect and not rendered; review these files if you did not expect it");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }

  const { values: o, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      title: { type: "string" },
      root: { type: "string" },
      model: { type: "string", short: "m" },
      judge: { type: "string", multiple: true },
      "filter-known": { type: "string" },
      budget: { type: "string" },
      baseline: { type: "boolean" },
      write: { type: "boolean" },
      json: { type: "boolean" },
      strict: { type: "boolean" },
      rehash: { type: "boolean" },
      ids: { type: "string" },
      decoder: { type: "boolean" },
      "no-anchors": { type: "boolean" },
      "keep-stale": { type: "boolean" },
      update: { type: "boolean" },
      "max-probes": { type: "string" },
      "no-synthesize": { type: "boolean" },
      concurrency: { type: "string" },
      "chunk-lines": { type: "string" },
      rpm: { type: "string" },
      "reasoning-effort": { type: "string" },
      "allow-write": { type: "boolean" },
      deps: { type: "boolean" },
      base: { type: "string" },
      format: { type: "string" },
      "link-base": { type: "string" },
      comment: { type: "boolean" },
      budgets: { type: "string" },
      runs: { type: "string" },
      free: { type: "boolean" },
      anchors: { type: "string" },
      probes: { type: "string" },
      quiet: { type: "boolean", short: "q" },
    },
  });
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
    return n;
  };
  const progress = o.quiet ? undefined : (m: string) => process.stderr.write(`${m}\n`);
  const clients: LLM[] = [];
  const llm = (spec: string) => {
    const c = createLLM(spec, { rpm: num(o.rpm, "rpm"), reasoningEffort: o["reasoning-effort"] });
    clients.push(c);
    return c;
  };
  const judges = () => (o.judge?.length ? o.judge.map(llm) : undefined);
  // Always tell the user what the run consumed, so costs and quotas are never a surprise.
  process.on("exit", () => {
    for (const c of clients) {
      const u = c.usage;
      if (u?.requests) {
        const retried =
          (u.retriedForReasoning ? `; ${u.retriedForReasoning} retried with a larger budget because reasoning used all output tokens` : "") +
          (u.truncated ? `; ${u.truncated} replies cut by the output limit (reasoning models: try --reasoning-effort low)` : "");
        process.stderr.write(`usage ${c.id}: ${u.requests} requests, ${u.inputTokens} input + ${u.outputTokens} output tokens (as reported by the provider)${retried}\n`);
      }
    }
  });

  switch (cmd) {
    case "init": {
      const out = o.output ?? positionals[0] ?? "project.hcs";
      if (existsSync(out)) throw new UsageError(`${out} already exists`);
      const doc = emptyDocument(o.title ?? basename(resolve(dirname(out))));
      if (o.root) doc.headers.root = o.root;
      writeFileSync(
        out,
        serialize(doc).replace(
          "[claims]\n",
          `[claims]\n// Write one claim per line, then cite its source with indented "> path:start-end" lines.\n// Run \`hcs seal ${basename(out)}\` to hash the anchors. Example:\n// #arch[manual] Requests are authenticated in middleware before reaching any handler.\n//   > src/middleware/auth.ts:10-42\n`,
        ),
      );
      console.log(`created ${out}`);
      return 0;
    }

    case "validate": {
      const file = requireFile(positionals);
      const doc = load(file);
      const version = /^\s*HCS\/(\S+)/m.exec(readFileSync(file, "utf8"))?.[1];
      console.log(`${file}: valid HCS/${version} (${doc.claims.length} claims, ${doc.probes.length} probes, ${doc.certificates.length} certificates)`);
      return 0;
    }

    case "check": {
      const file = requireFile(positionals);
      const doc = load(file);
      const cache = new SourceCache(rootDir(doc, file));
      const reports = checkDocument(doc, cache);
      const count = (k: "claim" | "probe", s: AnchorStatus) => reports.filter((r) => r.kind === k && r.status === s).length;
      const cs = claimStatus(reports);
      const certs = doc.certificates.map((c) => {
        const budget = c.fields.budget ? Number(c.fields.budget) : undefined;
        return { fields: c.fields, current: hashForCertificate(doc, cs, budget) === c.fields.digest };
      });
      const suspect = new Set(doc.claims.filter((c) => c.tags.includes("suspect") || injectionFindings(c.text).some((f) => f.severity === "high")).map((c) => c.id));
      const failing = reports.filter(
        (r) => r.status === "stale" || r.status === "missing" || (o.strict && (r.status === "unsealed" || suspect.has(r.id))),
      );

      if (o.json) {
        console.log(JSON.stringify({ file, items: reports, certificates: certs, ok: failing.length === 0 }, null, 2));
        return failing.length ? 1 : 0;
      }
      console.log(`${file}: ${doc.claims.length} claims, ${doc.probes.length} probes`);
      for (const k of ["claim", "probe"] as const) {
        const parts = (["ok", "moved", "review", "unsealed", "stale", "missing"] as AnchorStatus[])
          .map((s) => [s, count(k, s)] as const)
          .filter(([, n]) => n)
          .map(([s, n]) => `${n} ${s}`);
        if (parts.length) console.log(`  ${k}s: ${parts.join(", ")}`);
      }
      for (const r of reports.filter((r) => r.status !== "ok")) {
        for (const a of r.anchors.filter((a) => a.status !== "ok")) {
          const rel = a.relocated;
          const where = rel
            ? ` -> ${rel.path ? `${rel.path}${rel.symbol ? `::${rel.symbol}` : ""}` : `lines ${rel.start}-${rel.end}`}`
            : a.detail
              ? `  ${a.detail}`
              : "";
          console.log(`  ${ICON[a.status].padEnd(8)} ${r.id.padEnd(6)} ${formatAnchor(a.anchor, false)}${where}`);
        }
      }
      const flagged = doc.claims
        .map((c) => ({ c, f: injectionFindings(c.text) }))
        .filter((x) => x.f.length || x.c.tags.includes("suspect"));
      for (const { c, f } of flagged) {
        const high = c.tags.includes("suspect") || f.some((x) => x.severity === "high");
        console.log(`  ${high ? "SUSPECT " : "review  "} ${c.id.padEnd(6)} ${f.map((x) => x.reason).join("; ") || "tagged suspect"}${high ? " (not rendered)" : ""}`);
      }
      for (const c of certs) {
        console.log(`  certificate ${c.fields.model} fidelity=${c.fields.fidelity}: ${c.current ? "current" : "OUTDATED (context changed since it was scored)"}`);
      }
      if (reports.some((r) => r.status === "review")) {
        console.log(`  hint: "review" claims cite unchanged code that uses changed code; re-read them, then \`hcs seal ${file} --rehash --ids ...\``);
      }
      if (reports.some((r) => r.status === "moved" || r.status === "unsealed")) console.log(`  hint: run \`hcs seal ${file}\` to update moved/unsealed anchors`);
      if (doc.headers.incomplete) {
        console.log(`  note: partial file, ${doc.headers.incomplete.split(",").length} source chunk(s) not compiled yet (@incomplete); finish with \`hcs compile --update\``);
      }
      if (failing.length) {
        console.log(`FAIL: ${failing.length} item(s) no longer match their sources. Review them, then fix or \`hcs seal --rehash --ids ...\`, or recompile with --update.`);
        return 1;
      }
      const unsealed = reports.filter((r) => r.status === "unsealed").length;
      console.log(unsealed ? `OK, but ${unsealed} item(s) are unsealed and were not verified.` : "OK: every claim still matches its sources.");
      return 0;
    }

    case "seal": {
      const file = requireFile(positionals);
      const doc = load(file);
      const cache = new SourceCache(rootDir(doc, file));
      const ids = o.ids ? new Set(o.ids.split(",").map((s) => s.trim())) : undefined;
      const r = seal(doc, cache, { rehash: o.rehash, ids, deps: o.deps });
      if (r.sealed + r.relocated + r.rehashed + r.deps) {
        if (r.rehashed) doc.certificates = []; // sources changed: earlier scores no longer apply
        doc.headers.updated = new Date().toISOString();
        save(file, doc);
      }
      console.log(`${file}: ${r.sealed} sealed, ${r.relocated} relocated, ${r.rehashed} re-hashed${r.deps ? `, ${r.deps} dependency hash(es) updated` : ""}`);
      return 0;
    }

    case "render": {
      const file = requireFile(positionals);
      const doc = load(file);
      const reports = checkDocument(doc, new SourceCache(rootDir(doc, file)));
      const text = renderContext(doc, {
        status: claimStatus(reports),
        keepStale: o["keep-stale"],
        anchors: !o["no-anchors"],
        budget: num(o.budget, "budget"),
      });
      console.log(o.decoder ? `${DECODER_PROMPT}\n\n${text}` : text);
      return 0;
    }

    case "stats": {
      const file = requireFile(positionals);
      const doc = load(file);
      const fileTokens = estimateTokens(readFileSync(file, "utf8"));
      const ctx = renderContext(doc);
      const ctxTokens = estimateTokens(ctx);
      const src = Number(doc.headers["source-tokens"] || 0);
      const anchored = new Set(doc.claims.flatMap((c) => c.anchors.map((a) => a.path)));
      console.log(`${file}`);
      console.log(`  claims            ${doc.claims.length} (${doc.claims.filter((c) => c.tags.includes("manual")).length} hand-written)`);
      console.log(`  probes            ${doc.probes.length}`);
      console.log(`  files cited       ${anchored.size}${doc.headers["source-files"] ? ` of ${doc.headers["source-files"]}` : ""}`);
      console.log(`  .hcs file         ~${fileTokens} tokens`);
      console.log(`  rendered context  ~${ctxTokens} tokens`);
      if (src) console.log(`  source material   ~${src} tokens  (context is ${pct(ctxTokens / src)} of the source)`);
      for (const b of [500, 1000, 2000, 4000]) {
        if (b < ctxTokens) console.log(`  --budget ${String(b).padEnd(5)}    keeps ${selectClaims(doc, { budget: b }).length} claims`);
      }
      for (const c of doc.certificates) console.log(`  certificate       ${Object.entries(c.fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      console.log("  (token counts are tokenizer-free estimates)");
      return 0;
    }

    case "compile": {
      const model = requireModel(o.model);
      const out = o.output ?? "project.hcs";
      const previous = o.update && existsSync(out) ? load(out) : undefined;
      const outDir = dirname(resolve(out));
      const root = resolve(o.root ?? (previous ? rootDir(previous, out) : "."));
      const paths = positionals.length ? positionals.map((p) => relative(root, resolve(p)) || ".") : ["."];
      const { doc, stats } = await compile({
        root,
        paths,
        llm: llm(model),
        title: o.title ?? basename(root),
        previous,
        maxProbes: num(o["max-probes"], "max-probes"),
        synthesize: !o["no-synthesize"],
        anchorMode: anchorMode(o.anchors),
        concurrency: num(o.concurrency, "concurrency"),
        chunkLines: num(o["chunk-lines"], "chunk-lines"),
        onProgress: progress,
      });
      doc.headers.root = relative(outDir, root).split("\\").join("/") || ".";
      let knownCount: number | undefined;
      if (o["filter-known"]) {
        const specs = o["filter-known"].split(",").map((x) => x.trim()).filter(Boolean);
        progress?.(`probe quality filter: asking ${doc.probes.length} probes without context to ${specs.join(", ")}`);
        const known = await findKnownProbes(doc.probes, specs.map(llm), { judge: llm(model), concurrency: num(o.concurrency, "concurrency") });
        for (const p of doc.probes) {
          const rest = (p.tags ?? []).filter((t) => t !== "known");
          if (known.has(p.id)) rest.push("known");
          if (rest.length) p.tags = rest;
          else delete p.tags;
        }
        doc.headers["known-filter"] = specs.join(",");
        knownCount = known.size;
      }
      save(out, doc);
      const ctxTokens = estimateTokens(renderContext(doc));
      console.log(`wrote ${out}: ${doc.claims.length} claims, ${doc.probes.length} probes from ${stats.files} files (${stats.filesCompiled} compiled)`);
      console.log(`  rejected by quote verification: ${stats.claimsRejected}/${stats.claimsProposed} claims, ${stats.probesRejected}/${stats.probesProposed} probes`);
      printSourceFindings(stats.sourceFindings);
      if (stats.overview) console.log(`  overview ${stats.overview}; rerun with --update to try again`);
      if (knownCount !== undefined) console.log(`  probe quality filter: ${knownCount}/${doc.probes.length} probes tagged [known] (answered without context by every filter model)`);
      if (stats.incomplete) {
        console.log(`  INCOMPLETE: ${stats.incomplete.reason}`);
        if (stats.incomplete.chunks.length) console.log(`  not compiled yet: ${stats.incomplete.chunks.length} chunk(s): ${stats.incomplete.chunks.join(", ")}`);
        console.log(`  the partial file was saved; run the same command with --update later to finish it`);
        return 1;
      }
      console.log(`  context ~${ctxTokens} tokens for ~${stats.sourceTokens} tokens of source. Next: hcs score ${out} --model ${model} --baseline --write`);
      return 0;
    }

    case "score": {
      const file = requireFile(positionals);
      const doc = load(file);
      const reports = checkDocument(doc, new SourceCache(rootDir(doc, file)));
      const answerer = llm(requireModel(o.model));
      const judgeList = judges();
      const budget = num(o.budget, "budget");
      const runs = num(o.runs, "runs") ?? 1;
      // Results are saved per probe, so a score stopped by a quota resumes with the same command.
      const saved = scoreCacheFile(file, {
        digest: hashForCertificate(doc, claimStatus(reports), budget),
        probes: doc.probes.map((p) => [p.id, p.question, p.answer]),
        answerer: answerer.id,
        judges: (judgeList ?? [answerer]).map((j) => j.id),
        budget,
        runs,
      });
      if (saved.count) progress?.(`resuming: ${saved.count} probe result(s) saved by an earlier, interrupted run`);
      let result;
      try {
        result = await scoreDocument(doc, statusMap(reports), {
          answerer,
          judge: judgeList,
          budget,
          baseline: o.baseline,
          runs,
          concurrency: num(o.concurrency, "concurrency"),
          onProgress: progress,
          cache: saved.context,
          baselineCache: saved.baseline,
        });
      } catch (e) {
        if (e instanceof QuotaError) {
          throw new Error(`${e.message}\n${saved.count + saved.added()} probe result(s) are saved in ${saved.path}; run the same command later to resume.`);
        }
        throw e;
      }
      saved.remove();
      if (o.write) {
        doc.certificates.push(result.certificate);
        save(file, doc);
      }
      if (o.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log(`${file} scored with ${result.certificate.fields.model} (judge ${result.certificate.fields.judge}), context ~${result.contextTokens} tokens`);
      printScore("with context", result.withContext);
      if (result.baseline) {
        printScore("without context", result.baseline);
        console.log(`gain             ${((result.withContext.fidelity - result.baseline.fidelity) * 100).toFixed(1)} points`);
      }
      const ag = result.withContext.judgeAgreement;
      if (ag) {
        console.log(`judges agreed     ${pct(ag.agreement)} of ${ag.judged} judged answers (Cohen's kappa ${ag.kappa.toFixed(2)}); the stricter verdict was used`);
      }
      if (result.novel) {
        console.log(`novel            fidelity ${pct(result.novel.fidelity).padStart(6)} on the ${result.novel.probes} probes not tagged [known]`);
      }
      if (result.informative) {
        console.log(`informative      fidelity ${pct(result.informative.fidelity).padStart(6)} on the ${result.informative.probes} probes the model could not answer without context`);
      }
      if (result.withContext.probes < 20) console.log(`note: only ${result.withContext.probes} probes; the confidence interval is wide. Compile with more probes for a tighter estimate.`);
      if (result.selfJudged) console.log("note: the answering model also graded itself. Use --judge with a model from another family for an unbiased score.");
      if (result.skippedProbes.length) console.log(`skipped stale probes: ${result.skippedProbes.join(", ")}`);
      const misses = result.withContext.results.filter((r) => r.verdict !== "correct");
      if (misses.length) {
        console.log("not recovered from the context:");
        for (const r of misses) console.log(`  ${r.id} [${r.verdict}] ${r.question}`);
      }
      if (o.write) console.log(`certificate written to ${file}`);
      return 0;
    }

    case "curve": {
      const file = requireFile(positionals);
      const doc = load(file);
      const reports = checkDocument(doc, new SourceCache(rootDir(doc, file)));
      const answerer = llm(requireModel(o.model));
      const judgeList = judges();
      const runs = num(o.runs, "runs") ?? 1;
      const budgets = (o.budgets ?? "250,500,1000,2000,4000").split(",").map((b) => num(b.trim(), "budgets")!);
      // One resumable result store per budget, like `score`: a quota stop keeps every answered probe.
      const stores: ReturnType<typeof scoreCacheFile>[] = [];
      const cacheFor = (budget: number) => {
        const saved = scoreCacheFile(file, {
          digest: hashForCertificate(doc, claimStatus(reports), budget),
          probes: doc.probes.map((p) => [p.id, p.question, p.answer]),
          answerer: answerer.id,
          judges: (judgeList ?? [answerer]).map((j) => j.id),
          budget,
          runs,
        });
        if (saved.count) progress?.(`budget ${budget}: resuming with ${saved.count} saved probe result(s)`);
        stores.push(saved);
        return { context: saved.context, baseline: saved.baseline };
      };
      let curve;
      try {
        curve = await scoreCurve(doc, statusMap(reports), budgets, {
          answerer,
          judge: judgeList,
          runs,
          baseline: o.baseline,
          concurrency: num(o.concurrency, "concurrency"),
          onProgress: progress,
          cacheFor,
        });
      } catch (e) {
        if (e instanceof QuotaError) throw new Error(`${e.message}\nProbe results are saved; run the same command later to resume.`);
        throw e;
      }
      for (const s of stores) s.remove();
      if (o.write) {
        doc.certificates.push(...curve.points.map((p) => p.score.certificate));
        save(file, doc);
      }
      if (o.json) {
        console.log(JSON.stringify(curve, null, 2));
        return 0;
      }
      const first = curve.points[0]?.score;
      console.log(`${file}: fidelity by token budget, ${first?.withContext.probes ?? 0} probes, answered by ${answerer.id}, judged by ${first?.certificate.fields.judge}`);
      console.log("  budget  tokens  claims  fidelity  95% CI           misled  abstained");
      for (const p of curve.points) {
        const w = p.score.withContext;
        const ci = `${pct(w.ci95[0])}-${pct(w.ci95[1])}`;
        const mark = p.budget === curve.knee ? "  <- knee" : p.sameAs !== undefined ? `  (same context as ${p.sameAs})` : "";
        console.log(`  ${String(p.budget).padStart(6)}  ${String(p.tokens).padStart(6)}  ${String(p.claims).padStart(6)}  ${pct(w.fidelity).padStart(8)}  ${ci.padEnd(15)}  ${pct(w.misled).padStart(6)}  ${pct(w.abstained).padStart(9)}${mark}`);
      }
      if (first?.baseline) console.log(`  no context: fidelity ${pct(first.baseline.fidelity)}`);
      if (curve.knee !== undefined) {
        const best = curve.points.find((p) => p.budget === curve.best)!;
        console.log(`knee: ${curve.knee} tokens, the smallest budget within the 95% CI of the best fidelity (${pct(best.score.withContext.fidelity)} at ${best.budget})`);
        if (curve.flat) {
          console.log("note: the curve is flat within its confidence intervals: no budget did measurably better than the smallest, so the knee does not tell how much context is needed. More probes, or a model that uses the context, are needed.");
        }
      }
      if (first?.selfJudged) console.log("note: the answering model also graded itself. Use --judge with a model from another family.");
      if (o.write) console.log(`${curve.points.length} certificate(s) written to ${file}`);
      return 0;
    }

    case "snapshot": {
      const input = requireFile(positionals, "<conversation.json|.md>");
      const model = requireModel(o.model);
      const raw = readFileSync(input, "utf8");
      const name = basename(input, extname(input));
      const title = o.title ?? name;
      const out = o.output ?? join(dirname(input), `${name}.hcs`);
      const transcriptPath = join(dirname(resolve(out)), `${name}.transcript.md`);
      const text = extname(input).toLowerCase() === ".json" ? toTranscript(parseConversation(JSON.parse(raw)), title) : `<!-- hcs:transcript -->\n${raw}`;
      writeFileSync(transcriptPath, text);
      const root = dirname(transcriptPath);
      const { doc, stats } = await compile({
        root,
        paths: [basename(transcriptPath)],
        llm: llm(model),
        title,
        maxProbes: num(o["max-probes"], "max-probes") ?? 20,
        onProgress: progress,
        ignore: [],
      });
      doc.headers.root = relative(dirname(resolve(out)), root) || ".";
      save(out, doc);
      console.log(`wrote ${out} and ${relative(process.cwd(), transcriptPath)}: ${doc.claims.length} claims, ${doc.probes.length} probes`);
      printSourceFindings(stats.sourceFindings);
      console.log(`  paste the output of \`hcs render ${out} --decoder\` into any LLM to continue the session`);
      return 0;
    }

    case "audit": {
      const file = requireFile(positionals, "<context-file>");
      if (!existsSync(file)) throw new UsageError(`file not found: ${file}`);
      const text = readFileSync(file, "utf8");
      const root = resolve(o.root ?? dirname(file));
      const refs = findPathReferences(text, root);
      const broken = refs.filter((r) => !r.exists && !r.bare);
      const unresolved = refs.filter((r) => !r.exists && r.bare);
      console.log(`${file}: ~${estimateTokens(text)} tokens, ${refs.length} file references, ${broken.length} broken, ${unresolved.length} unresolved names`);
      for (const r of broken) console.log(`  BROKEN line ${r.line}: ${r.path}`);
      for (const r of unresolved) console.log(`  warning line ${r.line}: ${r.path} not found at the root (generic mention?)`);
      if (o.probes) {
        const probeDoc = load(o.probes);
        const reports = checkDocument(probeDoc, new SourceCache(rootDir(probeDoc, o.probes)));
        const status = statusMap(reports);
        const probes = probeDoc.probes.filter((p) => ["ok", "moved", "review"].includes(status.get(`probe:${p.id}`) ?? ""));
        const opts = {
          answerer: llm(requireModel(o.model)),
          judge: judges(),
          concurrency: num(o.concurrency, "concurrency"),
          onProgress: progress,
        };
        const s = await scoreContext(text, probes, opts);
        printScore(basename(file), s);
        if (o.baseline) printScore("without context", await scoreContext(null, probes, { ...opts, onProgress: undefined }));
      }
      return broken.length ? 1 : 0;
    }

    case "compare": {
      if (positionals.length !== 2) throw new UsageError("usage: hcs compare <a> <b> --model M [--probes file.hcs] (each side: an .hcs file, any text file, or none)");
      const probeFile = o.probes ?? positionals.find((p) => extname(p) === ".hcs");
      if (!probeFile) throw new UsageError("no probes: pass --probes file.hcs, or make one side an .hcs file");
      const probeDoc = load(probeFile);
      const status = statusMap(checkDocument(probeDoc, new SourceCache(rootDir(probeDoc, probeFile))));
      const probes = probeDoc.probes.filter((p) => ["ok", "moved", "review"].includes(status.get(`probe:${p.id}`) ?? ""));
      if (!probes.length) throw new UsageError(`no verified probes in ${probeFile}`);
      const contextOf = (side: string): string | null => {
        if (side === "none") return null;
        if (!existsSync(side)) throw new UsageError(`file not found: ${side}`);
        if (extname(side) !== ".hcs") return readFileSync(side, "utf8");
        const d = load(side);
        const reports = checkDocument(d, new SourceCache(rootDir(d, side)));
        return renderContext(d, { status: claimStatus(reports), budget: num(o.budget, "budget") });
      };
      const [a, b] = positionals;
      const answerer = llm(requireModel(o.model));
      const c = await compareContexts(contextOf(a), contextOf(b), probes, {
        answerer,
        judge: judges(),
        runs: num(o.runs, "runs"),
        concurrency: num(o.concurrency, "concurrency"),
        onProgress: progress,
      });
      if (o.json) {
        console.log(JSON.stringify(c, null, 2));
        return 0;
      }
      console.log(`compared on ${c.a.probes} probes from ${probeFile} with ${answerer.id}`);
      printScore(`A ${basename(a)}`.slice(0, 16), c.a);
      printScore(`B ${basename(b)}`.slice(0, 16), c.b);
      const sig = c.ci95[0] > 0 ? "B is better" : c.ci95[1] < 0 ? "A is better" : "no significant difference";
      console.log(
        `B - A            ${(c.difference * 100).toFixed(1)} points [95% paired CI ${(c.ci95[0] * 100).toFixed(1)} to ${(c.ci95[1] * 100).toFixed(1)}]: ${sig}`,
      );
      console.log(`per probe        B better on ${c.better}, worse on ${c.worse}, same on ${c.same}`);
      return 0;
    }

    case "impact": {
      const file = requireFile(positionals);
      if (!o.base) throw new UsageError("missing --base <git ref> (e.g. origin/main, or the pull request's base sha)");
      const doc = load(file);
      const root = rootDir(doc, file);
      const report = impact(doc, new SourceCache(root), gitChanges(root, o.base), o.base, baseDocument(file, o.base));
      // Links point at the anchor's file under the .hcs root, from the repository top level.
      const prefix = o["link-base"] ? gitPrefix(root) : "";
      if (o["link-base"] && prefix) o["link-base"] = `${o["link-base"].replace(/\/+$/, "")}/${prefix}`;
      if (o.comment) {
        const body = impactMarkdown(report, relative(process.cwd(), resolve(file)) || file, o["link-base"]);
        const quiet = !report.items.length && !report.claimsAdded.length && !report.claimsEdited.length && !report.claimsRemoved.length;
        const done = await upsertComment(githubContext(), COMMENT_MARKER, body, quiet);
        console.log(`pull request comment ${done}: ${report.items.length} item(s) cite changed code`);
      } else if (o.json) console.log(JSON.stringify(report, null, 2));
      else if (o.format === "markdown") process.stdout.write(impactMarkdown(report, relative(process.cwd(), resolve(file)) || file, o["link-base"]));
      else {
        console.log(`${file}: ${report.items.length} item(s) cite code changed since ${o.base} (${report.filesChanged} file(s) changed)`);
        for (const i of report.items) {
          console.log(`  ${i.id.padEnd(6)} [${i.status}] ${i.text.length > 100 ? `${i.text.slice(0, 97)}...` : i.text}`);
          for (const a of i.anchors) console.log(`         ${formatAnchor(a.anchor, false)}: ${a.reason}`);
        }
        const delta = [["added", report.claimsAdded], ["edited", report.claimsEdited], ["removed", report.claimsRemoved]].filter(([, l]) => l.length);
        if (delta.length) console.log(`  claims ${delta.map(([k, l]) => `${k}: ${(l as string[]).join(", ")}`).join("; ")}`);
      }
      return 0;
    }

    case "models": {
      const provider = requireFile(positionals, "<provider> (openai, anthropic, gemini, groq, openrouter, ollama)");
      let ids = await listModels(provider);
      if (o.free) ids = ids.filter((id) => id.endsWith(":free"));
      for (const id of ids) console.log(`${provider}:${id}`);
      if (!ids.length) console.log("(no models returned)");
      return 0;
    }

    case "serve": {
      const file = requireFile(positionals);
      const doc = load(file); // fail fast on a missing or invalid file
      // A cloned repository's .hcs file chooses its own @root. Refuse one that escapes the working directory
      // unless the user names the root, so a hostile file cannot widen the MCP sandbox to the whole disk.
      const root = o.root ? resolve(o.root) : rootDir(doc, file);
      if (!o.root) {
        try {
          if (relative(process.cwd(), root)) insideRoot(process.cwd(), root);
        } catch {
          throw new UsageError(`${file} sets @root to ${root}, outside the working directory; pass --root ${root} to serve it anyway`);
        }
      }
      await serveStdio(file, { root, allowWrite: o["allow-write"] });
      return 0;
    }

    default:
      throw new UsageError(`unknown command "${cmd}". Run \`hcs help\`.`);
  }
}

/**
 * Node's built-in fetch ignores HTTPS_PROXY unless started with --use-env-proxy (Node >= 22.21 / 24.5). Behind an
 * egress proxy, which may also be what injects the API key as a network secret, run the CLI again once with it.
 * Returns the child's exit code, or undefined when no re-run is needed or possible.
 */
function rerunBehindProxy(): number | undefined {
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxied || process.env.HCS_PROXY_RERUN || process.env.NODE_USE_ENV_PROXY) return undefined;
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) return undefined;
  const flags = ["--use-env-proxy", "--disable-warning=UNDICI-EHPA", ...process.execArgv];
  const child = spawnSync(process.execPath, [...flags, process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HCS_PROXY_RERUN: "1" },
  });
  return child.status ?? 1;
}

const rerun = rerunBehindProxy();
if (rerun !== undefined) process.exit(rerun);

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError || err instanceof HcsSyntaxError || (err as any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      console.error(`hcs: ${err.message}`);
      process.exit(2);
    }
    console.error(`hcs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

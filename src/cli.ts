#!/usr/bin/env node
// hcs: command-line interface for the Holographic Context Standard.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkDocument, rootDir, seal, SourceCache, type AnchorStatus, type ItemReport } from "./anchors.js";
import { findPathReferences } from "./audit.js";
import { compile } from "./compile.js";
import { emptyDocument, formatAnchor, HcsSyntaxError, parse, serialize, type HcsDocument } from "./format.js";
import { createLLM } from "./llm.js";
import { DECODER_PROMPT, estimateTokens, renderContext, selectClaims } from "./render.js";
import { hashForCertificate, scoreContext, scoreDocument, type ScoreSummary } from "./score.js";
import { parseConversation, toTranscript } from "./snapshot.js";

const VERSION = "0.1.0";

const HELP = `hcs ${VERSION} - Holographic Context Standard

Verifiable, fidelity-scored context files for any LLM.

Deterministic commands (no LLM, no network):
  hcs init [-o project.hcs] [--title T]       Create an empty .hcs file to write claims by hand
  hcs validate <file.hcs>                     Check syntax
  hcs check <file.hcs> [--strict] [--json]    Verify every anchor against the sources; exit 1 if stale
  hcs seal <file.hcs> [--rehash] [--ids a,b]  Fill missing hashes, follow moved anchors
                                              (--rehash: accept current content of stale anchors)
  hcs render <file.hcs> [--budget N]          Print the context block to give an LLM
             [--decoder] [--no-anchors] [--keep-stale]
  hcs stats <file.hcs>                        Sizes, token estimates, compression ratio
  hcs audit <context-file> [--root DIR]       Find broken file references in AGENTS.md, CLAUDE.md...
            [--probes file.hcs --model M]     ...and score it against an .hcs probe set

LLM commands (--model provider:model):
  hcs compile [paths...] --model M [-o project.hcs] [--root DIR] [--title T]
              [--update] [--max-probes N] [--no-synthesize] [--concurrency N]
  hcs score <file.hcs> --model M [--judge M] [--budget N] [--baseline] [--write] [--json]
  hcs snapshot <conversation.json|.md> --model M [-o session.hcs]

Providers: openai (OPENAI_API_KEY, OPENAI_BASE_URL for any compatible server),
           anthropic (ANTHROPIC_API_KEY), gemini (GEMINI_API_KEY), ollama (OLLAMA_HOST)

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

const ICON: Record<AnchorStatus, string> = { ok: "ok", moved: "moved", unsealed: "unsealed", stale: "STALE", missing: "MISSING" };

function requireFile(positionals: string[], what = "<file.hcs>"): string {
  if (!positionals[0]) throw new UsageError(`missing ${what}`);
  return positionals[0];
}

function requireModel(v: unknown): string {
  if (typeof v !== "string" || !v) throw new UsageError("missing --model provider:model (e.g. openai:gpt-4o-mini, ollama:llama3.1)");
  return v;
}

function printScore(label: string, s: ScoreSummary): void {
  console.log(`${label.padEnd(16)} fidelity ${pct(s.fidelity).padStart(6)}   misled ${pct(s.misled).padStart(6)}   abstained ${pct(s.abstained).padStart(6)}   (${s.probes} probes)`);
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
      judge: { type: "string" },
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
      console.log(`${file}: valid HCS/${"0.1"} (${doc.claims.length} claims, ${doc.probes.length} probes, ${doc.certificates.length} certificates)`);
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
      const failing = reports.filter((r) => r.status === "stale" || r.status === "missing" || (o.strict && r.status === "unsealed"));

      if (o.json) {
        console.log(JSON.stringify({ file, items: reports, certificates: certs, ok: failing.length === 0 }, null, 2));
        return failing.length ? 1 : 0;
      }
      console.log(`${file}: ${doc.claims.length} claims, ${doc.probes.length} probes`);
      for (const k of ["claim", "probe"] as const) {
        const parts = (["ok", "moved", "unsealed", "stale", "missing"] as AnchorStatus[])
          .map((s) => [s, count(k, s)] as const)
          .filter(([, n]) => n)
          .map(([s, n]) => `${n} ${s}`);
        if (parts.length) console.log(`  ${k}s: ${parts.join(", ")}`);
      }
      for (const r of reports.filter((r) => r.status !== "ok")) {
        for (const a of r.anchors.filter((a) => a.status !== "ok")) {
          const where = a.relocated ? ` -> lines ${a.relocated.start}-${a.relocated.end}` : a.detail ? `  ${a.detail}` : "";
          console.log(`  ${ICON[a.status].padEnd(8)} ${r.id.padEnd(6)} ${formatAnchor(a.anchor, false)}${where}`);
        }
      }
      for (const c of certs) {
        console.log(`  certificate ${c.fields.model} fidelity=${c.fields.fidelity}: ${c.current ? "current" : "OUTDATED (context changed since it was scored)"}`);
      }
      if (reports.some((r) => r.status === "moved" || r.status === "unsealed")) console.log(`  hint: run \`hcs seal ${file}\` to update moved/unsealed anchors`);
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
      const r = seal(doc, cache, { rehash: o.rehash, ids });
      if (r.sealed + r.relocated + r.rehashed) {
        if (r.rehashed) doc.certificates = []; // sources changed: earlier scores no longer apply
        doc.headers.updated = new Date().toISOString();
        save(file, doc);
      }
      console.log(`${file}: ${r.sealed} sealed, ${r.relocated} relocated, ${r.rehashed} re-hashed`);
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
        llm: createLLM(model),
        title: o.title ?? basename(root),
        previous,
        maxProbes: num(o["max-probes"], "max-probes"),
        synthesize: !o["no-synthesize"],
        concurrency: num(o.concurrency, "concurrency"),
        chunkLines: num(o["chunk-lines"], "chunk-lines"),
        onProgress: progress,
      });
      doc.headers.root = relative(outDir, root).split("\\").join("/") || ".";
      save(out, doc);
      const ctxTokens = estimateTokens(renderContext(doc));
      console.log(`wrote ${out}: ${doc.claims.length} claims, ${doc.probes.length} probes from ${stats.files} files (${stats.filesCompiled} compiled)`);
      console.log(`  rejected by quote verification: ${stats.claimsRejected}/${stats.claimsProposed} claims, ${stats.probesRejected}/${stats.probesProposed} probes`);
      console.log(`  context ~${ctxTokens} tokens for ~${stats.sourceTokens} tokens of source. Next: hcs score ${out} --model ${model} --baseline --write`);
      return 0;
    }

    case "score": {
      const file = requireFile(positionals);
      const doc = load(file);
      const reports = checkDocument(doc, new SourceCache(rootDir(doc, file)));
      const result = await scoreDocument(doc, statusMap(reports), {
        answerer: createLLM(requireModel(o.model)),
        judge: o.judge ? createLLM(o.judge) : undefined,
        budget: num(o.budget, "budget"),
        baseline: o.baseline,
        concurrency: num(o.concurrency, "concurrency"),
        onProgress: progress,
      });
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
      if (result.skippedProbes.length) console.log(`skipped stale probes: ${result.skippedProbes.join(", ")}`);
      const misses = result.withContext.results.filter((r) => r.verdict !== "correct");
      if (misses.length) {
        console.log("not recovered from the context:");
        for (const r of misses) console.log(`  ${r.id} [${r.verdict}] ${r.question}`);
      }
      if (o.write) console.log(`certificate written to ${file}`);
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
      const { doc } = await compile({
        root,
        paths: [basename(transcriptPath)],
        llm: createLLM(model),
        title,
        maxProbes: num(o["max-probes"], "max-probes") ?? 20,
        onProgress: progress,
        ignore: [],
      });
      doc.headers.root = relative(dirname(resolve(out)), root) || ".";
      save(out, doc);
      console.log(`wrote ${out} and ${relative(process.cwd(), transcriptPath)}: ${doc.claims.length} claims, ${doc.probes.length} probes`);
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
        const probes = probeDoc.probes.filter((p) => ["ok", "moved"].includes(status.get(`probe:${p.id}`) ?? ""));
        const opts = {
          answerer: createLLM(requireModel(o.model)),
          judge: o.judge ? createLLM(o.judge) : undefined,
          concurrency: num(o.concurrency, "concurrency"),
          onProgress: progress,
        };
        const s = await scoreContext(text, probes, opts);
        printScore(basename(file), s);
        if (o.baseline) printScore("without context", await scoreContext(null, probes, { ...opts, onProgress: undefined }));
      }
      return broken.length ? 1 : 0;
    }

    default:
      throw new UsageError(`unknown command "${cmd}". Run \`hcs help\`.`);
  }
}

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

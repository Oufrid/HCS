#!/usr/bin/env node
// D1 public benchmark, in resumable steps sized for free tiers. Run from the repository root after `npm run build`.
//
//   node bench/d1/d1.mjs prepare                         clone every repository of repos.json at its pinned commit
//   node bench/d1/d1.mjs compile   --model M [--repo r]  compile each repository into bench/d1/hcs/<name>.hcs
//   node bench/d1/d1.mjs summarize --model M [--repo r]  naive summary at the same token budget (the baseline)
//   node bench/d1/d1.mjs score --model A --judge J [--repo r]   score every condition on the same probes
//   node bench/d1/d1.mjs report                          tables from the saved results -> bench/d1/results.md
//
// Every step can be stopped by a quota and rerun: compile resumes through `@incomplete`, summaries and probe results
// are saved one by one (bench/d1/summaries/, bench/d1/results/). Conditions scored with the same probes:
//   hcs      the compiled context, rendered at the budget
//   none     no context (what the model knows on its own)
//   readme   the repository's own README, cut to the budget when longer (its full size is recorded)
//   agents   its AGENTS.md or CLAUDE.md, when it has one (cut the same way)
//   summary  a naive summary of the same sources by the compiling model, cut to the same budget

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Behind an HTTPS proxy, Node's fetch needs --use-env-proxy (the CLI does the same).
if (process.env.HTTPS_PROXY && !process.execArgv.includes("--use-env-proxy") && !process.env.HCS_D1_CHILD) {
  const r = spawnSync(process.execPath, ["--use-env-proxy", "--no-warnings", ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, HCS_D1_CHILD: "1" } });
  process.exit(r.status ?? 1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const dist = (m) => join(repoRoot, "dist", "src", m);
const { checkDocument, SourceCache } = await import(dist("anchors.js"));
const { parse } = await import(dist("format.js"));
const { createLLM, QuotaError, mapLimit } = await import(dist("llm.js"));
const { renderContext, estimateTokens } = await import(dist("render.js"));
const { bootstrapCI, scoreContext } = await import(dist("score.js"));
const { chunkFile, collectSources } = await import(dist("sources.js"));

const config = JSON.parse(readFileSync(join(here, "repos.json"), "utf8"));
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string" }, judge: { type: "string" }, repo: { type: "string" }, rpm: { type: "string" }, "reasoning-effort": { type: "string" } },
});
const step = positionals[0];
const repos = config.repos.filter((r) => !o.repo || r.name === o.repo || r.name.endsWith(`__${o.repo}`));
const work = join(repoRoot, "bench", ".work", "d1");
const rootOf = (r) => join(work, r.name);
const hcsFile = (r) => join(here, "hcs", `${r.name}.hcs`);
const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
const llm = (spec) => createLLM(spec, { rpm: Number(o.rpm ?? 8), reasoningEffort: o["reasoning-effort"] });
const readJSON = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback);
const writeJSON = (f, data) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(data, null, 1) + "\n");
};
const need = (name) => {
  if (!o[name]) {
    console.error(`${step} needs --${name} provider:model`);
    process.exit(2);
  }
  return o[name];
};

function prepare() {
  for (const r of repos) {
    const dir = rootOf(r);
    if (!existsSync(dir)) execFileSync("git", ["clone", "--quiet", "--no-checkout", r.url, dir], { stdio: "inherit" });
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== r.commit) {
      execFileSync("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", r.commit], { stdio: "inherit" });
      execFileSync("git", ["-C", dir, "checkout", "--quiet", r.commit], { stdio: "inherit" });
    }
    console.log(`${r.name} at ${r.commit.slice(0, 12)}`);
  }
}

function compile() {
  const model = need("model");
  for (const r of repos) {
    const out = hcsFile(r);
    mkdirSync(dirname(out), { recursive: true });
    const done = existsSync(out) && !/^@incomplete /m.test(readFileSync(out, "utf8"));
    if (done) {
      console.log(`${r.name}: compiled`);
      continue;
    }
    const args = [join(repoRoot, "dist", "src", "cli.js"), "compile", ...r.paths.map((p) => join(rootOf(r), p)), "--root", rootOf(r)];
    args.push("--model", model, "-o", out, "--title", r.name, "--chunk-lines", String(config.chunkLines), "--rpm", o.rpm ?? "8");
    args.push("--max-probes", String(config.maxProbes));
    if (o["reasoning-effort"]) args.push("--reasoning-effort", o["reasoning-effort"]);
    if (existsSync(out)) args.push("--update");
    mkdirSync(join(here, "logs"), { recursive: true });
    const res = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, HCS_DEBUG_LOG: join(here, "logs", `compile-${r.name}.jsonl`) } });
    if (res.status !== 0) {
      console.log(`${r.name}: compile stopped (exit ${res.status}); rerun this step later to resume`);
      return 3;
    }
  }
  return 0;
}

/** Naive baseline: each chunk summarized in proportion to its size, concatenated, cut to the budget. */
async function summarize() {
  const model = need("model");
  const writer = llm(model);
  for (const r of repos) {
    const file = join(here, "summaries", `${r.name}.json`);
    const saved = readJSON(file, { model, chunks: {} });
    const chunks = collectSources(rootOf(r), r.paths).flatMap((f) => chunkFile(f, readFileSync(join(rootOf(r), f), "utf8"), config.chunkLines));
    const total = chunks.reduce((s, c) => s + estimateTokens(c.lines.join("\n")), 0);
    try {
      await mapLimit(chunks, 1, async (c) => {
        const key = `${c.path}:${c.start}-${c.end}`;
        if (saved.chunks[key]) return;
        const words = Math.max(30, Math.round((config.budget * 0.75 * estimateTokens(c.lines.join("\n"))) / total));
        saved.chunks[key] = (
          await writer.complete({
            system: "You summarize source material for a developer who will work on it. Plain prose or bullet points, no preamble.",
            prompt: `Summarize this part of ${r.name} (${key}) in at most ${words} words: what it does, its main names, values and rules.\n\n${c.lines.join("\n")}`,
            maxTokens: 4096,
          })
        ).trim();
        writeJSON(file, saved);
      });
    } catch (e) {
      if (e instanceof QuotaError) {
        console.log(`${r.name}: summary stopped by the quota (${Object.keys(saved.chunks).length}/${chunks.length} chunks saved): ${e.message}`);
        return 3;
      }
      throw e;
    }
    // Assemble in source order and cut at the budget, as a naive summary of the same size as the context.
    let text = `# ${r.name}: summary\n`;
    for (const c of chunks) {
      const part = `\n## ${c.path}:${c.start}-${c.end}\n${saved.chunks[`${c.path}:${c.start}-${c.end}`]}\n`;
      if (estimateTokens(text + part) > config.budget) break;
      text += part;
    }
    saved.text = text;
    saved.tokens = estimateTokens(text);
    writeJSON(file, saved);
    console.log(`${r.name}: summary ~${saved.tokens} tokens from ${chunks.length} chunks by ${saved.model}`);
  }
  return 0;
}

/** A text cut at the last whole line within the budget, so that every condition gets the same room. */
function cut(text) {
  if (estimateTokens(text) <= config.budget) return text;
  const lines = text.split("\n");
  let out = "";
  for (const l of lines) {
    if (estimateTokens(`${out}${l}\n`) > config.budget) break;
    out += `${l}\n`;
  }
  return out;
}

function conditions(r, doc) {
  const status = new Map(checkDocument(doc, new SourceCache(rootOf(r))).filter((x) => x.kind === "claim").map((x) => [x.id, x.status]));
  const out = { hcs: renderContext(doc, { status, budget: config.budget }), none: null, readme: cut(readFileSync(join(rootOf(r), r.readme), "utf8")) };
  if (r.agents) out.agents = cut(readFileSync(join(rootOf(r), r.agents), "utf8"));
  const summary = readJSON(join(here, "summaries", `${r.name}.json`), null);
  if (summary?.text) out.summary = summary.text;
  return out;
}

function usableProbes(r, doc) {
  const reports = checkDocument(doc, new SourceCache(rootOf(r)));
  const ok = new Set(reports.filter((x) => x.kind === "probe" && ["ok", "moved", "review"].includes(x.status)).map((x) => x.id));
  return doc.probes.filter((p) => ok.has(p.id));
}

async function score() {
  const answerer = llm(need("model"));
  const judge = llm(need("judge"));
  for (const r of repos) {
    if (!existsSync(hcsFile(r)) || /^@incomplete /m.test(readFileSync(hcsFile(r), "utf8"))) {
      console.log(`${r.name}: not compiled yet, skipped`);
      continue;
    }
    const doc = parse(readFileSync(hcsFile(r), "utf8"));
    const probes = usableProbes(r, doc);
    for (const [name, context] of Object.entries(conditions(r, doc))) {
      const file = join(here, "results", r.name, `${safe(answerer.id)}--${safe(judge.id)}`, `${name}.json`);
      const full = name === "readme" ? estimateTokens(readFileSync(join(rootOf(r), r.readme), "utf8")) : undefined;
      const saved = readJSON(file, { repo: r.name, commit: r.commit, condition: name, answerer: answerer.id, judge: judge.id, budget: config.budget, tokens: context === null ? 0 : estimateTokens(context), ...(full ? { fullTokens: full } : {}), results: {} });
      if (probes.every((p) => saved.results[p.id])) continue;
      const cache = { get: (id) => saved.results[id], put: (res) => ((saved.results[res.id] = res), writeJSON(file, saved)) };
      try {
        const s = await scoreContext(context, probes, { answerer, judge, concurrency: 1, cache });
        console.log(`${r.name} ${name}: fidelity ${(s.fidelity * 100).toFixed(1)}% on ${s.probes} probes (${answerer.id}, judge ${judge.id})`);
      } catch (e) {
        if (e instanceof QuotaError) {
          console.log(`${r.name} ${name}: stopped by the quota, ${Object.keys(saved.results).length}/${probes.length} saved: ${e.message}`);
          return 3;
        }
        throw e;
      }
    }
  }
  return 0;
}

function report() {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "# D1 results",
    "",
    `Generated by \`node bench/d1/d1.mjs report\` from the raw per-probe results in \`bench/d1/results/\`. Budget ${config.budget} tokens for the HCS context and the summary; README and AGENTS.md as they are. Only complete conditions (every probe answered) are listed.`,
    "",
    "| Repository | Answerer (judge) | Probes | Condition | Tokens | Fidelity [95% CI] | Misled | HCS minus condition [95% CI] |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const rows = [];
  for (const r of config.repos) {
    const dir = join(here, "results", r.name);
    if (!existsSync(dir) || !existsSync(hcsFile(r))) continue;
    const probes = usableProbes(r, parse(readFileSync(hcsFile(r), "utf8"))).map((p) => p.id);
    for (const run of execFileSync("ls", [dir], { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
      const load = (c) => readJSON(join(dir, run, `${c}.json`), null);
      const hcs = load("hcs");
      const complete = (x) => x && probes.every((id) => x.results[id]);
      if (!complete(hcs)) continue;
      for (const c of ["hcs", "none", "readme", "agents", "summary"]) {
        const x = load(c);
        if (!complete(x)) continue;
        const pts = probes.map((id) => x.results[id].points);
        const fid = pts.reduce((a, b) => a + b, 0) / pts.length;
        const [lo, hi] = bootstrapCI(pts);
        const misled = probes.filter((id) => x.results[id].verdict === "incorrect").length / probes.length;
        let diff = "";
        if (c !== "hcs") {
          const d = probes.map((id) => hcs.results[id].points - x.results[id].points);
          const [dl, dh] = bootstrapCI(d);
          diff = `${(d.reduce((a, b) => a + b, 0) / d.length * 100).toFixed(1)} [${(dl * 100).toFixed(1)}, ${(dh * 100).toFixed(1)}]`;
        }
        lines.push(`| ${r.name} (${r.language}) | ${x.answerer} (${x.judge}) | ${probes.length} | ${c} | ${x.tokens} | ${pct(fid)} [${pct(lo)}-${pct(hi)}] | ${pct(misled)} | ${diff} |`);
        rows.push({ repo: r.name, commit: r.commit, answerer: x.answerer, judge: x.judge, condition: c, tokens: x.tokens, probes: probes.length, fidelity: fid, ci95: [lo, hi], misled });
      }
    }
  }
  writeFileSync(join(here, "results.md"), lines.join("\n") + "\n");
  writeJSON(join(here, "results.json"), rows);
  console.log(lines.join("\n"));
  return 0;
}

const steps = { prepare, compile, summarize, score, report };
if (!steps[step]) {
  console.error("usage: node bench/d1/d1.mjs prepare|compile|summarize|score|report [options]");
  process.exit(2);
}
process.exitCode = await steps[step]();

#!/usr/bin/env node
// Reproducible benchmark: compile + score public repositories with one or more models.
// Usage: node bench/run.mjs --model openai:gpt-4o-mini [--judge M] [--budget 2000] [repo-url ...]
// Results are appended to bench/results.jsonl; nothing is published without the raw file.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "src", "cli.js");
const DEFAULT_REPOS = [
  "https://github.com/sindresorhus/ky",
  "https://github.com/pallets/click",
  "https://github.com/spf13/cobra",
];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string", multiple: true }, judge: { type: "string" }, budget: { type: "string" }, work: { type: "string" } },
});
if (!values.model?.length) {
  console.error("usage: node bench/run.mjs --model provider:model [--model ...] [--judge M] [--budget N] [repo-url ...]");
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error("build first: npm run build");
  process.exit(2);
}

const work = values.work ?? join(here, ".work");
mkdirSync(work, { recursive: true });
const hcs = (args, cwd) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

for (const url of positionals.length ? positionals : DEFAULT_REPOS) {
  const name = url.split("/").slice(-2).join("__");
  const dir = join(work, name);
  if (!existsSync(dir)) execFileSync("git", ["clone", "--depth", "1", url, dir], { stdio: "inherit" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const compiler = values.model[0];
  hcs(["compile", "--model", compiler, "-o", "bench.hcs", "-q"], dir);
  for (const model of values.model) {
    const args = ["score", "bench.hcs", "--model", model, "--baseline", "--json", "-q"];
    if (values.judge) args.push("--judge", values.judge);
    if (values.budget) args.push("--budget", values.budget);
    const r = JSON.parse(hcs(args, dir));
    const row = {
      repo: url,
      commit,
      compiler,
      model,
      judge: values.judge ?? model,
      budget: values.budget ? Number(values.budget) : null,
      fidelity: r.withContext.fidelity,
      baseline: r.baseline?.fidelity ?? null,
      misled: r.withContext.misled,
      probes: r.withContext.probes,
      contextTokens: r.contextTokens,
      date: new Date().toISOString(),
    };
    appendFileSync(join(here, "results.jsonl"), JSON.stringify(row) + "\n");
    console.log(JSON.stringify(row));
  }
}

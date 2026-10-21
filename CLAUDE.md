# CLAUDE.md

Guidance for AI agents (and humans) working on this repository.

## What this is

HCS (Holographic Context Standard): a plain-text format (`*.hcs`) whose claims cite hashed sources, plus a
zero-dependency TypeScript CLI and MCP server. Read `README.md` for the pitch, `SPEC.md` (v0.2) for the
normative format, `PRIOR_ART.md` for positioning and known limitations. `project.hcs` describes this repo in
HCS itself and is checked in CI: run `node dist/src/cli.js render project.hcs` for a quick overview.

## Commands

```bash
npm install && npm run build      # tsc -> dist/
npm test                          # build + node:test (mock OpenAI/Anthropic servers, no network)
npm run check:self                # verify project.hcs against the sources
node dist/src/cli.js help
```

## Conventions

- Everything in the repo is in English.
- No runtime dependencies. Node >= 18.17. Tests use `node:test` and live in `test/*.test.ts`.
- Honesty is a feature: never present illustrative numbers as results, label example output, and document
  limitations in README/PRIOR_ART. Benchmark numbers are only quoted with the raw results file that `bench/run.mjs` writes.
- When a change touches code cited by `project.hcs`, `npm run check:self` fails. Read the claim; if it still
  holds, `node dist/src/cli.js seal project.hcs --rehash --ids <id>`; otherwise edit the claim first. Keep
  `check --strict` green.
- Spec changes go in `SPEC.md` with a version note; readers must keep accepting older versions.

## Real-model testing

- Keys come from the cloud environment: either env vars (`GEMINI_API_KEY`, `GROQ_API_KEY`, ...) or network
  secrets injected by the egress proxy (then the variable is absent but requests are authenticated).
  Never print, log or commit a key; never ask for one in chat.
- Free tiers: always pass `--rpm` (start with 8) and keep runs small; every LLM command prints its usage.
- Free-tier prompts may be used by the provider: only run on public code (this repo, public repos).
- Use `node dist/src/cli.js models <provider>` to get real model ids; never guess them.
- Prefer a judge from another model family than the answering model (e.g. Gemini answers, Groq judges).

## Current status and next steps

v0.2 is complete and tested against mocks only. Not yet done:

1. Validate with real models: `compile` this repo (`src SPEC.md README.md`), then
   `score --baseline --judge ...`; fix whatever real outputs break (JSON parsing, quote matching, judge
   verdicts, rate limits). Report results honestly, including failures.
2. Run `bench/run.mjs` on a few small public repos; commit its raw results file only from real runs.
3. Later: Python implementation + language-agnostic conformance suite, PR bot, signed certificates,
   fidelity-vs-budget curves, dependency-aware invalidation.

The maintainer communicates in French; answer in French, keep repository content in English.

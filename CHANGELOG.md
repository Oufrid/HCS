# Changelog

All notable changes to the HCS CLI (`hcs-cli` on npm), the Python package (`hcs-format`) and the format (`SPEC.md`).
Versions of the CLI and of the format are separate: the CLI reads and writes every format version it lists.

## SPEC 1.0 (2026-10-22)

- The format is frozen as 1.0: no change from 0.3. `HCS/1.0` is accepted by both implementations and means the same
  as `HCS/0.3`; writers keep emitting the oldest version that fits. `SPEC.md` §9 lists what stays stable across 1.x.

## 0.3.0

Experimental: the first release on npm (`hcs-cli`) and PyPI (`hcs-format`). Implements format SPEC 1.0 (identical to 0.3).

### Format (SPEC 0.3)
- Probe tags and the `known` tag; `@known-filter` and `@incomplete` headers.
- Dependency hashes on symbol anchors (`#hash/deps`) and the non-failing `review` status.
- Certificate fields for two judges (`judge-agreement`, `judge-kappa`, `judged`), novel fidelity, curves (`curve`,
  `knee`), Ed25519 signatures (`key`, `sig`, `@keys`) and counted tokens (`tokenizer`).
- The `@parser` header naming the symbol locator; the `recorded` tag for claims written by agents.
- Readers keep accepting 0.1 and 0.2; writers emit the oldest version that fits.

### Render profiles
- `compact` (SPEC 6.2): `id: text` without anchors and, under a budget, hand-written claims first then one claim
  per source file in turn. Default for `score`, `curve`, `compare`, `refine` and the MCP context; `hcs render`
  keeps `full`. Certificates record `render=compact`; `check` verifies each certificate in its own profile.
  Measured on D1: anchors took 31% to 39% of a 2,000-token `full` render, and `full` left up to half of a
  repository's files without a single claim.

### CLI
- Runs on real free tiers (Gemini, Groq) and local models (Ollama): proxy support, `--rpm`, `--reasoning-effort`,
  quota errors that name the limit, and resume after a quota stop for `compile`, `score`, `curve` and `refine`.
- `mistral` provider; `reasoning_effort` is dropped for a model whose provider rejects it, list-shaped replies keep
  only their text parts, and a 429 whose rate-limit header is zero fails at once.
- `score`: probe quality filter (`compile --filter-known`), two judges, `--runs`, paired `compare`.
- `curve`: fidelity by token budget and its knee.
- `refine`: fills the gaps failed probes reveal with verified claims, with held-out probes.
- `seal --deps` and the `review` status; `impact` for pull requests (`--comment`, GitHub Action `mode: impact`).
- `keygen`, `score --sign`, `check --trusted`, `badge`.
- `--tokenizer` for provider token counts; `--parser tree-sitter` (optional packages) for TS/JS/Python symbols.
- MCP server: resources, `hcs_record` behind `--allow-write`, root sandbox for every source read.
- Security: injection guard tuned on a corpus, source scan at compile time, fuzzed parser, `SECURITY.md`.

### Python (`hcs-format` 0.3.0, first release)
- Deterministic core: parse, serialize, check, seal, render, dependency hashes and signature checks; `hcs-py`
  command. Passes the same conformance suite as the TypeScript CLI.

### Project
- Conformance suite (`conformance/`), cross-check between the two implementations, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, RFC process (`rfcs/`), tutorial, FAQ and an example project.

## 0.2.0 (not published)

Symbol anchors, MCP server, scoring with confidence intervals and baselines, injection guard, free-tier support.

## 0.1.0 (not published)

First version of the spec, the reference CLI, tests and the GitHub Action.

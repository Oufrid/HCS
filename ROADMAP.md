# Roadmap

The plan to take HCS from a working v0.2 to a standard that tools and AI providers can adopt.
Each item has a status and a **Done when** line. An item is done only when its criterion is met, with tests,
docs and `project.hcs` updated. Update this file in the same commit that changes an item's status.

Status: `[x]` done · `[~]` partly done (the remaining work is listed) · `[ ]` not started

Adoption needs four things, which the phases follow: **proven value** (A), **a stable, testable standard with
integration paths** (B), **capabilities nobody else has** (C), and **an ecosystem and governance** (D).

---

## Phase A: Reliability (blocks everything else)

### A1. Validate on real models `[x]`
Done (2026-10-21, details and raw artifacts in `bench/REPORT.md` and `bench/a1/`):
- Keys checked; compile and score ran end to end on this repository with three model families (Gemini compiles
  and judges, OpenAI-oss compiles, answers and judges, Qwen answers), on free tiers with `--rpm 8`.
- Quote verification kept 85.5% (Gemini) and 89.4% (Groq gpt-oss) of proposed quotes.
- Fourteen problems found on real outputs and fixed, each with a mock regression test: reasoning models
  (empty or cut replies, `--reasoning-effort`), free-tier quotas and outages (compile and score now save and
  resume their work), Groq's 413, unescaped JSON, Markdown-stripped quotes, silent failures, proxy routing.
- Honest result: fidelity is low (44.6% and 16.3%), because probes ask about details that a 7-16% context
  drops; the context rarely misleads (0-2.7%). Follow-ups: A3's probe filter and C2's refinement, measured.
- Local CPU models (Ollama) work but are slow and less faithful: a complement for testing, not for results.

### A2. Symbol anchors `[x]`
`path::Symbol` with whitespace-insensitive hashes, cross-file move detection, dependency-free locator.
Optional follow-ups go to C12.

### A3. Statistical rigor `[x]`
Done: bootstrap CI, `--runs`, informative fidelity, self-judging warning; probe quality filter
(`compile --filter-known`, `[known]` probe tags, `novel` fidelity); two judges with agreement and Cohen's kappa,
stricter verdict counts; `hcs compare` with a paired bootstrap CI. Spec bumped to 0.3 (probe tags). Tested with
mocks only; real-model behavior is part of A1.

### A4. Security `[x]`
Done: injection guard (suspect tag, never rendered), decoder rule, MCP root sandbox, quote verification;
red-team corpus `test/fixtures/injection/` (39 attacks, 40 benign look-alikes, plus a held-out set of 15 + 15)
with precision and recall in the tests and README; source scan in `compile` and `snapshot`; `SECURITY.md`
threat model; parser fuzz tests. Results: the high-risk level catches 35/39 corpus attacks (in-sample, after
tuning) but only 7/15 held-out attacks, with no false positive in either. The fuzzer found three round-trip bugs
in the parser and the threat-model review found that anchors could read files outside the root through
`hcs_expand`; all are fixed with regression tests. Possible follow-up: better held-out recall (an optional
model-based classifier), measured on a new held-out set.

---

## Phase B: Standard and integration (the path to adoption)

### B1. MCP server `[x]`
Done: `hcs serve` with 5 tools, root sandbox, tests over stdio; MCP resources `hcs://context` and
`hcs://claim/<id>` (plus a resource template); `hcs_record` behind `--allow-write`, which validates the text and
every anchor, seals the claim (tags `manual,recorded`, specified in SPEC 0.3) and writes atomically. Verified with
a real client: a recorded Claude Code 2.1.306 session used every tool, a resource and `hcs_record`
(`docs/mcp-session-2026-10-21.md`); `claude mcp list` reports the server connected. Setup documented for Claude
Code, Claude Desktop, Cursor and VS Code in `docs/mcp.md`, with example configs in `examples/mcp/`; only Claude
Code was actually tested.

### B2. Conformance suite and second implementation `[x]`
Done: `conformance/` has 36 language-agnostic cases (parse and its errors, serialization, symbol ranges for
TypeScript, Python, Markdown, YAML, JSON, Go, Rust and Java, anchor hashes, check statuses including moves within
and across files and a missing root, seal, render with budgets, certificate digests), documented in
`conformance/README.md` and SPEC section 10. `python/` is a dependency-free implementation (Python >= 3.9) of
parse, serialize, hashing, symbol location, check, seal and render, with a small CLI. Both pass 100% of the cases in
CI (Node 18/20/22, Python 3.9/3.13), and `conformance/cross_check.py` also compares them on every file of this
repository, its real `.hcs` files and 3,000 mutated inputs. The suite found two bugs in the reference (`fn new` not
located; a missing `@root` crashed `check`), both fixed. Publishing on PyPI is part of B4.

### B3. Pull-request bot `[ ]`
- `hcs impact <file.hcs> --base <ref>`: claims and probes whose anchors are affected by the diff between
  `<ref>` and the working tree.
- A GitHub Action mode that posts (and updates, not duplicates) one PR comment listing the affected claims, with
  links to their anchors. No secrets are needed for this.
- Optional: with a model available, propose updated claim text in the comment. Never commit automatically.
- **Done when:** the action works on a test PR in this repository, and `impact` has tests.

### B4. Distribution `[ ]`
- Publish `hcs-cli` on npm (check that the name is free, or choose another), with provenance. Publish the
  Python package on PyPI after B2.
- Versioned GitHub releases, CHANGELOG.md, and a `v0` tag for the Action.
- **Done when:** `npx hcs-cli check project.hcs` works from a clean machine, and the maintainer approved the
  publication. Publishing is outward-facing, so ask before doing it.

---

## Phase C: Capabilities nobody else has

### C1. Fidelity-vs-budget curve `[ ]`
- `hcs curve <file.hcs> --model M --budgets 250,500,1000,2000,4000`: fidelity with CI at each budget, plus the
  "knee" (smallest budget within 1 CI of the best score).
- Store the curve in the file (certificate per budget, or a `!curve` line; spec it).
- **Done when:** the curve is implemented, specified and tested, and one real curve is published in
  `bench/REPORT.md`.

### C2. Self-improving compilation `[ ]`
- `hcs refine <file.hcs> --model M`: use failed probes to find gaps, extract claims that fill them from the
  cited sources (quote verification still applies), and drop claims that no probe ever relies on (measured by
  ablation within the budget). Repeat while fidelity improves beyond the CI.
- Guard against overfitting: hold out a share of the probes (e.g. 30%) that refine never sees, and report
  fidelity on them.
- **Done when:** refine improves held-out fidelity on at least two real repositories, documented with raw
  numbers. If it does not, document that honestly.

### C3. Dependency-aware invalidation `[ ]`
- Build a lightweight reference graph: which symbols a symbol calls or imports, using the existing symbol
  locator plus identifier matching.
- `check` marks a claim `review` (a new, non-failing status) when a symbol its anchor depends on changed.
  Spec the status.
- **Done when:** this works on JS/TS and Python with tests, and the false-positive rate on this repository's
  history is measured and reported.

### C4. Signed certificates `[ ]`
- `score --sign` signs the certificate with an Ed25519 key (`node:crypto`, no dependency). `check` verifies the
  signature against keys listed in the file or in a trusted keys file.
- A "verified by" badge generator (SVG) for READMEs, showing fidelity and model, only for signed and current
  certificates.
- **Done when:** signing and verification are implemented, specified and tested, including tampering cases.

### C5. Better tokens and parsing (optional back-ends) `[ ]`
- An optional real tokenizer when a provider exposes token counting, keeping the estimate as fallback.
- An optional tree-sitter back-end for the symbol locator, behind a flag, never a hard dependency.
- **Done when:** both are available, default behavior is unchanged, and the conformance suite still passes.

---

## Phase D: Ecosystem and governance

### D1. Public benchmark `[ ]`
- Run `bench/run.mjs` on ≥ 5 public repositories (several languages and sizes) with ≥ 2 model families, with
  the raw results committed.
- `bench/REPORT.md` with tables, CIs, the method and its limitations.
- Compare with the baselines: no context, the repo's own README/AGENTS.md (via `audit`), and an equal-budget
  naive summary.
- **Done when:** the report is published and every number in README links to it.

### D2. Spec 1.0 and governance `[ ]`
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates.
- A lightweight RFC process (`rfcs/`) for spec changes.
- Freeze SPEC 1.0 once B2 passes in two implementations and D1 is published: stable anchor syntax and hashing,
  and a versioning policy.
- **Done when:** these documents exist and SPEC 1.0 is tagged.

### D3. Documentation and examples `[ ]`
- `examples/`: a small project in several languages with its `.hcs` file, a conversation snapshot, an audited
  AGENTS.md, and an MCP config.
- A short tutorial ("from zero to a certified context in 10 minutes") and an FAQ covering honest limits.
- **Done when:** a new user can follow the tutorial end to end without help. Test it in a clean session.

---

## Working rules for whoever picks this up

1. Order: **A1 first** (it can invalidate assumptions), then A3, A4, B1, B2, B3, then C, then B4/D.
   Ask the maintainer before reordering.
2. One item, or a coherent part of one, per commit or PR. Keep `npm test` and
   `node dist/src/cli.js check project.hcs --strict` green at every commit.
3. Add claims to `project.hcs` for every new feature (hand-written, anchored to symbols, sealed).
4. Never invent results. If something does not work or does not improve the metric, say so in the report.
5. Ask the maintainer before anything outward-facing: publishing packages, opening PRs, posting comments,
   creating releases.

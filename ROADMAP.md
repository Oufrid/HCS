# Roadmap

The plan to take HCS from a working v0.2 to a standard that tools and AI providers can adopt.
Each item has a status and a **Done when** line. An item is done only when its criterion is met, with tests,
docs and `project.hcs` updated. Update this file in the same commit that changes an item's status.

Status: `[x]` done · `[~]` partly done (the remaining work is listed) · `[ ]` not started

Adoption needs four things, which the phases follow: **proven value** (A), **a stable, testable standard with
integration paths** (B), **capabilities nobody else has** (C), and **an ecosystem and governance** (D).

---

## Phase A: Reliability (blocks everything else)

### A1. Validate on real models `[~]`
Every LLM path is tested only against mocks so far.
Done (2026-10-21): key check in the cloud sandbox; fixed two proxy bugs it revealed (Node fetch ignored
`HTTPS_PROXY`; misleading auth errors), see `bench/REPORT.md`. Blocked: neither key authenticates yet (Groq
rejects the injected secret, Gemini gets none), so no compile/score run has happened.
- Check that the keys work (`hcs models gemini`, `hcs models groq`) without printing them.
- `compile src SPEC.md README.md --rpm 8` with a Gemini model, then `score --baseline --judge groq:<model> --runs 1`.
- Fix whatever real outputs break: JSON extraction, quote matching rates, judge verdict parsing, abstention
  detection, rate limits and quota errors, long or truncated outputs, chunks with no claims.
- Record what happened in `bench/REPORT.md`: models, dates, commands, numbers, failures. No polishing.
- **Done when:** compile and score run end to end on this repo with two model families. At least 80% of
  proposed claims pass quote verification, or the reasons they do not are documented and addressed. Every bug
  found has a regression test with a mock.

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

### B1. MCP server `[~]`
Done: `hcs serve` with 5 tools, root sandbox, tests over stdio.
Remaining:
- Verify with a real client: add a `.mcp.json` example and check it works with Claude Code. Document steps for
  Claude Desktop, Cursor and VS Code.
- Expose the rendered context and the claims as MCP *resources* (`hcs://context`, `hcs://claim/<id>`).
- `hcs_record` tool (opt-in flag `--allow-write`): lets an agent add a hand-written claim with an anchor, sealed
  automatically. This is the write path that keeps the context alive during agent work.
- **Done when:** a documented, reproduced session with a real MCP client exists, and resources plus
  `hcs_record` are tested.

### B2. Conformance suite and second implementation `[ ]`
A format with one implementation is a tool, not a standard.
- `conformance/`: language-agnostic cases as files, each a directory with sources, an `.hcs` file and
  `expected.json`. Cover parse results and errors, hashes for every anchor form, symbol ranges per language,
  verification statuses (ok/moved/stale/missing/unsealed, cross-file moves), render output with budgets,
  certificate digests.
- The TypeScript implementation runs the suite in CI (`npm run conformance`).
- `python/`: a Python package (`hcs`, zero dependencies, Python ≥ 3.9) implementing parse, serialize, hash,
  symbol location, check, seal and render. It passes the same suite in CI.
- **Done when:** both implementations pass 100% of the conformance cases in CI.

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

# Prior art and positioning

HCS was designed after looking for existing tools that already solve its problem. This page lists what we found, so that users can pick the right tool and contributors can avoid reinventing things. Corrections are welcome. If something already does what HCS does, we want to know.

## What exists

| Area | Examples | What it does | What it does not do |
|---|---|---|---|
| Agent context files | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `llms.txt` | Conventions for where to put human-written context for agents and LLMs. | No link from statements to sources, no staleness detection, no measure of what they convey. Studies of public `AGENTS.md` files report that drift is common ([usewire](https://usewire.io/blog/agents-md-466-projects-context-engineering/), [githubnext curator issues](https://github.com/githubnext/gh-aw-cao/issues/13637)). |
| Repository packers | Repomix, gitingest | Concatenate a repository into one prompt-ready file. | No compression with known loss, no verification. |
| Repository maps | Aider's repo map | Ranked map of symbols for code editing. | Code only, signatures rather than semantics, no verification or scoring. |
| Doc drift detection | doc-drift-detector skills, `autohand docs drift`, CI recipes ([understandingdata](https://understandingdata.com/posts/doc-drift-detection-ci/)), Swimm's code-coupled docs | Flag documentation that may no longer match code, using path mapping, AST checks or LLM review. | Not a portable format for LLM context. No per-statement content hashes or relocation. No fidelity measurement. |
| Prompt compression | LLMLingua-2, Sentinel, SCOPE ([arXiv 2403.12968](https://arxiv.org/pdf/2403.12968), [2505.23277](https://arxiv.org/pdf/2505.23277), [2508.15813](https://arxiv.org/pdf/2508.15813)) | Remove tokens from prompts while preserving task performance. | Output is not human-readable or verifiable. Research-oriented, usually tied to specific models. |
| Summary and compression evaluation | Factory's probe-based evaluation of agent context compression ([factory.ai](https://factory.ai/news/evaluating-compression)), DeepEval's summarization metric (coverage questions), Ragas faithfulness | Ask questions to measure what a compressed context retains. | A method or metric, not a file format. Probes are not stored with the context, are not tied to source anchors, and are not invalidated when sources change. |

## Survey, October 2026: linting and verifying agent context files

A survey on 2026-10-22 found the space crowded. Verified (page or README read): **agentslint**, **etymd**,
**vigiles** and **agents-md-doctor** lint `AGENTS.md`, `CLAUDE.md` and Cursor rules for dead paths and missing
commands and fail CI (vigiles also posts a pull-request comment); **docpin** pins Markdown to `file:lines` or a
Python symbol with an inline content hash and fails CI when stale; **docrot** anchors documentation claims to a hash
of the normalized symbol body and annotates pull requests; Claude Code Review flags `CLAUDE.md` statements that a
pull request makes outdated (LLM, paid). Seen in search results only: ctxlint, ctxharness, cclint, rules-auditor,
DeepDocs, Ruler, rulesync, agentscribe. Generators (`/init` in Claude Code and Codex, several MCP generators)
write context files without citations. An ETH study reported in secondary sources (arXiv 2602.11988) found that
LLM-generated context files slightly lowered coding agents' success (about -0.5 to -3%) and raised cost, while
developer-written files helped (+4%); HCS's D1 benchmark measures question answering, not agent task success.

So HCS is not first at linting agent files, nor at hash-pinning documentation to code. What did not turn up
elsewhere, as a combination: a citation with a content hash required on every statement of an agent context file,
generation that checks each quote verbatim, a deterministic pull-request comment listing the statements whose cited
lines changed, and MCP expansion from a statement to its cited code. This is an impression from one survey, not a
proof of absence.

## What HCS adds

None of the individual ideas is new. HCS combines them into one **portable, model-agnostic file** that:

1. ties every claim to a **content-hashed source**: a function, class, heading or line range (traceability),
2. detects drift **deterministically and without an LLM**. Symbol hashes ignore whitespace, so reformatting is not drift, and code that only *moved*, even to another file, is told apart from code that *changed* (verification),
3. stores **probes whose answers are proven verbatim in the source** next to the claims, and invalidates them with the same anchors,
4. records **fidelity certificates** bound to a digest of the exact context that was scored, with a bootstrap confidence interval, a no-context baseline, an "informative" fidelity and a "misled" rate (measurement),
5. supports **token budgets at render time**, so one file serves small local models and large hosted ones,
6. applies the same mechanism to **code, prose and conversations** (session hand-off between LLMs),
7. serves all of it over **MCP**, so a model reads the compact claims first and opens the exact cited source only when needed.

HCS complements the formats above rather than competing with them. `hcs audit` checks an existing `AGENTS.md` for broken references and scores it with HCS probes.

## Known limitations

- Fidelity scores depend on the answering model, the judge model and the probe set. A probe set produced by the same compiler model can share that model's blind spots. Use a different `--judge`, and add hand-written probes for what matters most.
- Line-range anchors can flag a claim as stale after an edit that did not change its meaning. That is a false positive, and it is safe: a human re-seals the anchor. The opposite case is not covered: a change *outside* every anchor that makes a claim false goes unnoticed. Anchor claims to the code that enforces them.
- Token counts are tokenizer-free estimates unless `--tokenizer` is given, and budgets always use the estimate. On
  this repository's context it was 11% above Groq's count for gpt-oss-120b (bench/c5/tokens-groq.txt); other
  tokenizers differ.
- The symbol locator is heuristic and dependency-free, not a full parser. It reports what it cannot resolve as missing rather than guessing, but unusual syntax can still produce a wrong range. The optional tree-sitter back-end (`--parser tree-sitter`) covers TypeScript, JavaScript and Python only, and the Python implementation (hcs-py) does not have it: it refuses files sealed with it.
- `hcs refine` overfits: on two repositories it raised fidelity on the probes it optimized for, not on held-out
  probes (bench/REPORT.md, C2).
- The injection guard is pattern-based. It stops common attacks, not a determined adversary: on a held-out
  set it caught 7 of 15 novel attacks (see README, Security).

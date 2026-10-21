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
- Token counts are tokenizer-free estimates.
- The symbol locator is heuristic and dependency-free, not a full parser. It reports what it cannot resolve as missing rather than guessing, but unusual syntax can still produce a wrong range. A tree-sitter back-end is a possible future option.
- The injection guard is pattern-based. It stops common attacks, not a determined adversary: on a held-out
  set it caught 7 of 15 novel attacks (see README, Security).

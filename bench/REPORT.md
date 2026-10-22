# Benchmark and real-model report

Raw log of every real-model run: models, dates, commands, numbers and failures, unpolished. Numbers here are
only quoted from runs actually performed; anything not run is marked as such.

## A1. Real-model validation

### 2026-10-21: key check in a cloud sandbox (no model call succeeded)

Environment: Claude Code cloud container, Node v22.22.0, egress through an agent proxy (`HTTPS_PROXY`), keys
configured as proxy-injected network secrets (no `GEMINI_API_KEY` / `GROQ_API_KEY` variable in the environment).

Commands: `hcs models gemini`, `hcs models groq`, plus `curl` against the same endpoints to separate HCS bugs
from configuration problems.

| Provider | Result | Diagnosis |
|---|---|---|
| groq | HTTP 401 `invalid_api_key`, response header `x-proxy-error: upstream auth failed` | The proxy injects a credential, Groq rejects it: the stored secret value or its format is wrong. |
| gemini | `/v1beta/openai/models`: HTTP 404; `/v1beta/openai/chat/completions`: HTTP 400 "Missing or invalid Authorization header"; native `/v1beta/models`: HTTP 403 "unregistered callers" | No credential reaches Google at all: the proxy does not inject one for this host. |

Bugs found in HCS (fixed, with mock regression tests in `test/llm.test.ts`):

1. Node's built-in `fetch` ignores `HTTPS_PROXY` unless started with `--use-env-proxy`. Requests left the
   sandbox without going through the proxy, so a proxy-injected key could never be used. The CLI now re-runs
   itself once with that flag when `HTTPS_PROXY` is set.
2. The auth error always said "no API key was sent", even when the proxy had injected one that the provider
   rejected. It now reports the proxy's `x-proxy-error` header, and also recognizes Gemini's unauthenticated
   404/400 answers.

Status at that point: blocked on environment configuration.

### 2026-10-21: keys fixed

The network secrets had a free-text label in the "name" field, which is the HTTP header name, so the proxy sent
`Gemini API Key: ...` instead of `Authorization: Bearer ...`. With name `Authorization` and prefix `Bearer `, both
`hcs models gemini` and `hcs models groq` list models, and a one-word completion works on
`gemini:gemini-3.8-flash`, `groq:openai/gpt-oss-120b` and `groq:qwen/qwen3.8-27b`.

### 2026-10-21: first real compile attempts (Gemini)

Command (with the model and `--update` varying between attempts, as quotas ran out):
`hcs compile src SPEC.md README.md --model gemini:<model> --rpm 8 --chunk-lines 400 -o bench/a1/hcs.hcs`.
Raw logs: `bench/a1/compile*.txt` in order (the two earliest `gemini-3.8-flash` attempts were overwritten; their outcome is in rows 3 and 5 below).

What real providers did, and what it broke in HCS:

| # | Observation | Effect in HCS before the fix | Fix (each with a mock regression test) |
|---|---|---|---|
| 1 | `gemini-2.5-flash` answers 404 "no longer available to new users". | Clear error; nothing to fix. | Use `hcs models gemini`; the report uses 3.x models. |
| 2 | `groq:openai/gpt-oss-120b` with `max_tokens` 20 returns `content: ""`, `finish_reason: "length"`: the hidden reasoning used the whole budget. The judge used 50 tokens. | A reasoning judge would silently grade every answer "incorrect". | Retry once with a larger budget (4096, raised to 16384 after row 12) when the content is empty and the reply was cut; caps raised (answers and judge 1024, extraction 8192: unused tokens cost nothing); cut replies are counted in the usage line. |
| 3 | Gemini free tier: `GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20`. The 429 asks to wait about 19.6 hours. | The compile stopped after 9 chunks and **all extracted work was lost**. | `compile` keeps finished chunks, writes the rest to an `@incomplete` header, and `--update` compiles only those chunks. The quota message names the quota and its limit. |
| 4 | Google bills some model aliases as another model: large requests to `gemini-3.7-flash` were billed (and refused) as `gemini-3.8-flash`, and `gemini-3.5-flash` as `gemini-3.6-flash`, while tiny requests went through. | Confusing: a "fresh" model was refused at its first request. | The quota message now names the billed model (`quotaDimensions.model`). |
| 5 | `gemini-3.5-flash` (billed as 3.6) returned about 180 visible tokens per chunk and HCS extracted **0 claims from 6 chunks**, without any warning. Most likely hidden reasoning used most of the 3000-token cap and cut the JSON; this could not be confirmed because the quota was gone and replies were not logged. | Silent loss of whole chunks. | `HCS_DEBUG_LOG=<file>` logs every request and reply; a reply without usable JSON marks the chunk `@incomplete` (retried by `--update`) and is reported; extraction cap raised to 8192. |
| 6 | `gemini-3.1-flash-lite` copied `=== "high"` from `src/guard.ts` into a JSON string without escaping the quotes. | Chunk dropped as unparsable. | `extractJSON` repairs unescaped quotes, raw control characters and invalid backslash escapes; the real reply now yields 6 claims and 3 probes. |
| 7 | `gemini-3.1-flash-lite` answered 503 "high demand" on all 6 attempts at the 15th chunk. | Unhandled error: the run crashed and lost 14 chunks of work. | A provider still failing after every retry raises the same stop as a quota, so the partial work is saved. |


More fixes from the runs below (same rules: each with a mock regression test):

| # | Observation | Effect in HCS before the fix | Fix |
|---|---|---|---|
| 8 | `gemini-3-flash-preview` cut its JSON at about 300 visible tokens out of an 8192 budget: hidden reasoning used the rest. With `reasoning_effort: "low"` the same request ends normally (922 output tokens). | Chunk retried forever by `--update`. | `--reasoning-effort` (or `HCS_REASONING_EFFORT`), sent only when given, since accepted values differ per model. |
| 9 | Groq answers 413 when prompt + `max_tokens` exceeds the 8000 tokens-per-minute limit, and its "Requested" count varies between calls. | Crash; all compiled chunks lost. | Shrink `max_tokens` by the reported excess plus a margin, up to three times. |
| 10 | Any provider error other than a quota (the 413 above) crashed `compile`. | Lost work. | `compile` saves partial work on any provider failure. |
| 11 | Models quote Markdown without its markup (`` `hcs serve` `` quoted as `hcs serve`, `**Fidelity**` as `Fidelity`). | On `gemini-3-flash-preview`, only 18.2% of quotes from Markdown chunks were accepted. | Quote matching ignores Markdown inline markup and typographic quotes on both sides (SPEC 0.3 allows it). Same replies: 77.3% to 90.9% accepted overall, docs 18.2% to 72.7%, code unchanged at 97.0% (`bench/quote-rate.mjs`). |
| 12 | `gpt-oss-20b` returned an empty overview reply (4096 tokens of hidden reasoning); the retry did not trigger because its threshold was 4096. | Overview silently missing. | Retry budget 16384; a failed overview step is reported and retried by `--update`. |
| 13 | Groq limits each model to 200,000 tokens per day (rolling). One score at a ~4,000-token context needs about 160,000 tokens; the second score stopped after 10 probes. | `score` lost all results. | `score` saves each probe result in `.hcs-cache/` and resumes with the same command; no certificate from a partial score. |
| 14 | Groq's quota body names the limit, but HCS only printed "wait 1062s". | Unclear stop. | Quota messages keep the provider's explanation ("tokens per day (TPD): Limit 200000, Used 193664"). |

### 2026-10-21: end-to-end runs on a frozen commit

Sources: commit `681f82e` (`src/`, `SPEC.md`, `README.md`: 15 files, ~57,630 estimated tokens), checked out in a
separate worktree so that fixes made during the runs could not change the material being compiled. The CLI
was the current build at each step (fixes were added between runs). Reproduce the sources with
`git worktree add bench/.work/a1 681f82e`. Artifacts: `bench/a1/` (CLI outputs, the two `.hcs` files with their
certificates, `quote-rate.txt`) and `bench/a1/logs/*.jsonl.gz` (every request and reply, from
`HCS_DEBUG_LOG`; no keys; `gunzip` them before `bench/quote-rate.mjs`).

**Compile** (`--rpm 8 --concurrency 1`):

| File | Models (in order, as quotas ran out) | Chunks | Claims | Probes | Quotes accepted | Rendered context |
|---|---|---|---|---|---|---|
| `gemini.hcs` | `gemini-3-flash-preview` with `--reasoning-effort low --chunk-lines 600` (8 chunks, then the daily quota), finished with `gemini-flash-lite-latest` (7 chunks + overview) | 15 | 95 (8 overview) | 37 | 124/145 = **85.5%** as compiled (93.8% with the current matcher on the same replies) | ~4,259 tokens (7.4% of the source) |
| `groq.hcs` | `groq:openai/gpt-oss-120b` (22 chunks over four runs, stopped by a 413 crash, then twice by the tokens-per-day limit), finished with `groq:openai/gpt-oss-20b` (2 chunks + overview) | 24 | 173 (8 overview) | 40 | 236/264 = **89.4%** | ~9,109 tokens (15.8%) |

Two claims in `gemini.hcs` are tagged `suspect`: they describe the injection guard and quote its examples. This is
an expected false positive of a guard that does not know whether text is about attacks or is one.

**Score** (`--baseline --runs 1`, answering model and judge from different families):

| File | Answers | Judge | Budget | Fidelity [95% CI] | Without context | Informative | Misled | Abstained |
|---|---|---|---|---|---|---|---|---|
| `gemini.hcs` | `groq:qwen/qwen3.8-27b` | `groq:openai/gpt-oss-20b` | full (~4,259) | **44.6%** [31.1%-60.8%] | 0.0% | 44.6% (37 probes) | 2.7% | 48.6% |
| `groq.hcs` | `groq:openai/gpt-oss-20b` | `gemini:gemini-flash-lite-latest` | 4000 (~3,918) | **16.3%** [5.0%-28.7%] | 20.0% | 17.2% (32 probes) | 0.0% | 82.5% |

The second line uses another answering model because Qwen's daily token quota was spent by the first score
(`score-groq-1-qwen-quota.txt`). The full `groq.hcs` context (~9,100 tokens) cannot be scored on Groq's free tier at
all: a single request would exceed the 8,000 tokens-per-minute limit, hence `--budget 4000`.

**What this shows, without polishing:**

- The pipeline runs end to end on real models from three families (Gemini, OpenAI-oss, Qwen), on free tiers,
  after the fourteen fixes above. Quote verification keeps 85-89% of what the models propose.
- Fidelity is low. Most misses are abstentions, and the abstentions are correct: checking the misses by hand,
  the expected answers (exit codes, default limits, regexes, constants) are not in the rendered context. The
  probes ask about details of the source; a context of 7-16% of the source keeps the main behavior and drops
  those details. With a 4,000-token budget, `groq.hcs` scores below the no-context baseline: the answering model
  guesses some general facts correctly without context (SHA-256, Node versions), while the decoder rule makes
  it abstain when the context does not state them.
- So the context rarely misleads (0-2.7%), but it answers less than half of the probes. Two levers to test
  later, with numbers: the probe quality filter (`--filter-known`, A3) and gap-driven refinement (C2).
- The two lines are not a comparison: different probes, different answering models, different budgets. Each is
  one run with 37-40 probes, so the intervals are wide.

### 2026-10-21: local models (CPU only), as a complement

Ollama 0.40.7 in the cloud container (4 CPUs, 15 GB RAM, no GPU), compiling single files of the same sources:

| Model | Time per chunk | Replies with usable JSON | Quotes accepted |
|---|---|---|---|
| `ollama:qwen2.5:3b` | 88 s (48 lines), 188-213 s (193 lines) | 1 of 3 | 8/11 = 72.7% |
| `ollama:qwen2.5:7b` | 279 s (48 lines), 583 s (193 lines) | 2 of 2 | 12/22 = 54.5% |

Ollama's default 4,096-token context window cut the first 193-line reply; serve with `OLLAMA_CONTEXT_LENGTH=16384`.
A full compile of this repository would take several hours on this machine, with lower quote fidelity than the
hosted models. Local models are useful to exercise the pipeline without quotas, not to produce the published
numbers.

## C1. Fidelity-vs-budget curve

### 2026-10-21: local models (CPU), a flat curve

Command: `hcs curve bench/a1/gemini.hcs --model ollama:qwen2.5:7b --judge ollama:llama3.2:3b --budgets
250,500,1000,2000,4000,8000 --baseline --concurrency 1 --write` (Ollama 0.40.7, 4 CPUs, `OLLAMA_CONTEXT_LENGTH=16384`).
Output: `bench/c1/curve-local.txt`; every request and reply: `bench/c1/logs/curve-local.jsonl.gz`. The six
certificates are in `bench/a1/gemini.hcs`.

| Budget | Context tokens | Claims | Fidelity [95% CI] | Abstained |
|---|---|---|---|---|
| 250 | 245 | 4 | 0.0% [0.0-0.0] | 100.0% |
| 500 | 461 | 7 | 0.0% [0.0-0.0] | 100.0% |
| 1000 | 951 | 18 | 0.0% [0.0-0.0] | 100.0% |
| 2000 | 1941 | 40 | 0.0% [0.0-0.0] | 100.0% |
| 4000 | 3906 | 84 | 2.7% [0.0-8.1] | 94.6% |
| 8000 (full) | 4259 | 93 | 8.1% [0.0-18.9] | 91.9% |
| no context | 0 | 0 | 0.0% | |

The curve is flat: the best point's interval includes 0, so the computed knee (250) says nothing about how much
context is needed; `hcs curve` now prints that warning. The cause is the answering model, not the context:
`qwen2.5:7b` answered "UNKNOWN" even when the claim stating the answer was in its prompt (for example
`REASONING_BUDGET` = 4096, claim `c62`), and the Ollama log shows no truncation (`truncated = 0`). With the same
full context, `groq:qwen/qwen3.8-27b` scored 44.6% (A1). Small local models follow the decoder rule "answer only
from the context, else UNKNOWN" too literally to measure anything. The run took about 25 minutes for 259 requests
thanks to Ollama's prompt-prefix cache.

### 2026-10-22: Gemini 3.8 Flash, an informative curve

Command: `hcs curve bench/a1/gemini.hcs --model gemini:gemini-3.8-flash --judge groq:openai/gpt-oss-20b --budgets
250,500,1000,2000,4000 --reasoning-effort low --rpm 8 --concurrency 1 --baseline --write` (paid key; 316,045 input
tokens). Output: `bench/c1/curve-gemini.txt`; every request and reply: `bench/c1/logs/curve-gemini.jsonl.gz`; the
five certificates are in `bench/a1/gemini.hcs`.

| Budget | Context tokens | Claims | Fidelity [95% CI] | Misled | Abstained |
|---|---|---|---|---|---|
| 250 | 245 | 4 | 0.0% [0.0-0.0] | 0.0% | 100.0% |
| 500 | 461 | 7 | 1.4% [0.0-4.1] | 2.7% | 94.6% |
| 1000 | 951 | 18 | 5.4% [0.0-13.5] | 0.0% | 94.6% |
| 2000 | 1941 | 40 | 9.5% [1.4-18.9] | 2.7% | 86.5% |
| 4000 | 3906 | 84 | 32.4% [18.9-47.3] | 8.1% | 56.8% |
| no context | 0 | 0 | 0.0% | | |

Fidelity rises with the budget and is clearly above zero only from 2,000 tokens. The knee is the largest budget
tested (4,000), which means no plateau was reached: on this file (about 4,300 tokens in full), the model keeps
gaining from more claims, and the budget selection by importance does not put the claims these probes need first.
These are the compiler's own probes (see D1 for why that favors the context); the shape, not the level, is the
result. A second curve with groq:qwen/qwen3.8-27b is still running on Groq's free tier and will be added when it
completes.

## C3. Dependency-aware invalidation

### 2026-10-21: false-positive rate on this repository's history

Script: `bench/c3/history.mjs` (output `bench/c3/events.json`). It replays the 27 first-parent commits of the work
branch up to this change. For each of the 60 symbol anchors of `project.hcs` (as of HEAD) and each pair of
consecutive commits where the symbol exists in both (1,201 observations), it compares the symbol's own hash and the
hashes of its direct dependencies. 56 observations are own changes (`stale`); 18 are **review events**: own text
unchanged, a dependency changed.

Each event was judged by reading the claim and the dependency's diff (by the agent that wrote the code, so with that
bias):

| Events | Judged | Why |
|---|---|---|
| 1 | needed | `quote-guard` (cites `compile.ts::anchorFor`): `locateQuote` started ignoring Markdown markup, and the claim said quotes were matched "ignoring whitespace and case" only. It was corrected by hand at the time. |
| 3 | not needed | `format.ts::Probe` gained an optional `tags` field; the compile claims did not depend on it. |
| 1 | not needed | `format.ts::parse` accepted probe tags; the `hcs_record` claim is unaffected. |
| 4 | not needed | `SourceCache` gained the root sandbox; `checkAnchor`, `checkSymbolAnchor`, `findMovedSymbol` and `seal` claims unaffected. |
| 4 | not needed | `score.ts::answer` and `judge` got larger token caps; one of these edges (`scoreDocument` -> `judge`) is a false dependency: the identifier `judge` there is an object key. |
| 1 | not needed | `scoreContext` gained a result cache; the `--filter-known` claim is unaffected. |
| 1 | not needed | `braceSymbols` located `fn new`; the locator claim is still true. |
| 3 | not needed | `collectSources` returned no files for a missing root; compile and sandbox claims unaffected. |

**False-positive rate: 17/18 (94%).** Depth-1 name matching flags most dependency changes, and most dependency changes
do not change what a claim says. `review` is not a failure, so the cost is reviewer attention: here 18 extra reviews
over 26 commits, against 56 direct invalidations. Recall cannot be measured from this history alone: the only
claim known to have been invalidated through a dependency was caught. Cheap improvements to try with numbers: ignore
type-only dependencies (interfaces, type aliases), and identifiers used as object keys.

## C5. Optional tokenizer and tree-sitter back-end

### 2026-10-21: real token counts against the estimate

`hcs stats project.hcs --tokenizer groq:openai/gpt-oss-120b --rpm 8` (output `bench/c5/tokens-groq.txt`). Groq has no
counting endpoint, so HCS sends a 1-token completion with the text as the only message and reads the reported
prompt size, minus the chat framing measured once with a one-token message. 3 requests, 6,832 input tokens.

| Text | Estimate | Counted | Estimate / counted |
|---|---|---|---|
| `project.hcs` (the file) | 4,061 | 3,914 | 103.8% |
| its rendered context | 3,012 | 2,704 | 111.4% |

One file and one tokenizer: this shows the estimate is in the right range here, not how far off it is in general
(code-heavy text, other languages and other tokenizers will differ). The Anthropic and native Gemini counting
endpoints are implemented and tested against mock servers only: no Anthropic key is available here, and the Gemini
key in this sandbox is injected by the proxy as a Bearer token, which the native endpoint does not accept (HCS then
falls back to the 1-token completion, which uses one of the about 20 daily Gemini requests, so it was not run).

### 2026-10-21: tree-sitter versus the heuristic locator

Script: `bench/c5/symbols.mjs` (output `bench/c5/symbols-agreement.txt`), on the 51 TypeScript, JavaScript and Python
files of this repository at the C5 commit (conformance case sources excluded).

- Symbols found by both: 474; same range: 470 (99.2%).
- Found only by the heuristic: 12. Seven are Python definitions inside a string literal of
  `conformance/make_cases.py` (test source embedded as text): the heuristic is wrong there. Five are wrong nestings
  of one-line object members (`scoreCacheFile.get.put`, `SIGNATURE_LABEL.unsigned.trusted...`).
- Found only by tree-sitter: 8, the same one-line members correctly named (`SIGNATURE_LABEL.trusted`), plus a
  method signature, a `let` without initializer and a constructor the heuristic does not list.
- Different ranges: 4, the same one-line objects, and a multi-line template literal end.

On `bench/a1/gemini.hcs`, compiled and sealed with the heuristic (104 symbol anchors in TS/JS/Python), all 132
items still check `ok` with `--parser tree-sitter`. Every difference found is a heuristic error, but the sample
is one repository written in one style, by the same author as the heuristic.

### 2026-10-21: two candidate refinements, measured (not adopted)

`bench/c3/history.mjs --variant types,keys` recomputes the review events with two changes to the dependency rule,
in the benchmark only (SPEC 5.5 is unchanged): ignore dependencies on TypeScript interfaces and type aliases
(`types`), and ignore names the body uses only as object keys or as another object's property (`keys`; `this.x`
and `self.x` still count).

On the same 27 commits as above (outputs `bench/c3/events.json` and `bench/c3/events-types-keys.json`):

| Rule | Review events | Needed | Dropped |
|---|---|---|---|
| SPEC 5.5 | 18 | 1 | |
| `types` | 15 | 1 | 3 (`format.ts::Probe`, an interface) |
| `keys` | 16 | 1 | 2 (`judge` used as an object key) |
| `types,keys` | 13 | 1 | 5, all judged not needed |

On the whole history up to the C5 commit, 33 commits (`events-head.json`, `events-head-types-keys.json`): 38
events with the current rule, 24 with both refinements. The 20 events after the first 27 commits were judged the
same way (same bias). Two were needed: `statuses` when `checkSymbolAnchor` gained the `review` status (the claim
was edited by hand in that commit), and `magic` when `parseAnchor` accepted `#hash/deps` (the claim, about which
version the writer emits, stayed out of date until the C5 commit). Both are kept by the refinements; every dropped
event was judged not needed.

| Rule, 33 commits | Review events | Needed | False-positive rate |
|---|---|---|---|
| SPEC 5.5 | 38 | 3 | 35/38 (92%) |
| `types,keys` | 24 | 3 | 21/24 (88%) |

The refinements remove about a third of the reviews without losing a needed one on this history, but most reviews
remain unneeded: the main source left is classes used as parameter types (`cache: SourceCache`), which a regex
cannot tell from a use. Three needed events is too few to claim recall is preserved in general. Proposed as an RFC
(`rfcs/0000-deps-ignore-types-and-keys.md`), since it changes the normative dependency hash; postponed by the
maintainer until there is more evidence.

## C2. Self-improving compilation (`hcs refine`)

### 2026-10-22: first repository (this one, `bench/a1/gemini.hcs`), budget 1,000 tokens: no held-out gain

Command (output `bench/c2/a1-refine.txt`, model replies `bench/c2/logs/a1-refine.jsonl`, result
`bench/c2/a1-refined.hcs`):

```
hcs refine bench/a1/gemini.hcs -o bench/c2/a1-refined.hcs --model groq:openai/gpt-oss-120b \
  --judge groq:qwen/qwen3.8-27b --budget 1000 --reasoning-effort low --rpm 8 --concurrency 1
```

gpt-oss-120b wrote the new claims and answered the probes; qwen3.8-27b judged. The file was compiled by Gemini
(A1). 11 of the 37 probes were held out, never shown to refine. The run was stopped once by Groq's daily token
quota after round 1 and resumed the next day from its saved results (121 requests in total).

| | Fidelity [95% CI] | Abstained | Probes |
|---|---|---|---|
| Training, before | 7.7% [0.0%-17.3%] | 88.5% | 26 |
| Training, after | 19.2% [5.8%-34.6%] | 76.9% | 26 |
| **Held-out, before** | **4.5% [0.0%-13.6%]** | 90.9% | 11 |
| **Held-out, after** | **4.5% [0.0%-13.6%]** | 90.9% | 11 |

- Round 1: 25 failed training probes, 29 claims proposed, all 29 quote-verified and new; training fidelity rose
  from 7.7% to 19.2%, so the round was kept. Round 2: 27 more verified claims, no training gain, not kept.
- **Held-out fidelity did not change.** The gain is on the probes refine optimized for, which is what the hold-out
  is there to expose.
- Why, in part: under the 1,000-token budget only **3 of the 29 added claims are rendered** (the budget keeps
  claims by importance, then file order, and 23 of the new claims share the top importance with the existing
  ones). The answering model never saw the other 26, and the 3 it saw displaced 3 original claims. The training gain
  comes from those 3 claims.
- The setting is harsh: at 1,000 tokens the model abstained on about 90% of the probes before refining.

What this says: on this file, at this budget, refine overfits to the training probes and does not generalize.
It does not say whether the added claims would help without a budget, since most of them were never rendered.
Next measurements, with the same split: the same file without a budget (about four times the tokens), and the
second repository (pallets/itsdangerous, once compiled for D1). A possible change, to be measured rather than
assumed: under a budget, rank claims by how many training probes they help (ablation) instead of by the writer's
importance.

## D1. Public benchmark

Protocol, repositories and known biases: `bench/d1/README.md`. Full table with per-repository CIs:
`bench/d1/results.md` (raw per-probe answers and verdicts in `bench/d1/results/`).

### 2026-10-22: first model family (Gemini 3.8 Flash answers, gpt-oss-20b judges)

All five repositories were compiled and summarized by one model, gemini-3.8-flash (paid key; 379,536 input and
99,360 output tokens). A first attempt on free tiers used five different Gemini models and is archived in
`bench/d1/archive-mixed/` without results. Every context gets the same 2,000-token budget.

Pooled over the 147 probes of the five repositories (paired bootstrap, 95% CI):

| Condition | Fidelity [95% CI] | HCS minus condition |
|---|---|---|
| HCS context | 29.9% [23.1%-37.4%] | |
| No context | 30.3% [22.8%-37.8%] | -0.3 points [-10.5, +10.2] |
| README (cut to the budget) | 8.8% [4.8%-13.6%] | **+21.1 points [+13.6, +29.3]** |
| Naive summary, same budget | 23.5% [17.0%-30.6%] | +6.5 points [-1.4, +14.3] |

Per repository, HCS minus no context: kilo -25.9, itsdangerous +16.7, anyhow +10.0, cobra -13.3, ky +8.3
points (every interval includes 0 or nearly).

What this shows, and what it does not:

- **HCS clearly beats the repositories' own README** at the same budget, on every repository (ky's AGENTS.md:
  0.0%, HCS 26.7%). This is the only difference that is clearly outside the noise.
- **HCS does not measurably beat a naive summary of the same size** made by the same model: +6.5 points, with an
  interval that includes zero. With 147 probes, a real gain of a few points cannot be shown.
- **HCS does not beat no context at all, pooled.** On the two best-known projects (antirez/kilo, spf13/cobra) the
  model answers better from its own knowledge: without context it may use what it knows, while every context
  condition tells it to answer only from the context and to say "UNKNOWN" otherwise. The no-context condition
  measures something different (memory of public code), and it favors popular repositories. A private codebase
  would not have this advantage, but none was measured.
- Fidelity is low everywhere (about 30%): the probes ask precise details (names, values, messages) and 2,000
  tokens cover a small part of 13k to 76k tokens of source.
- The probes are written by the compiling model from the chunks it compiles, which favors HCS over the README and
  the summary (`bench/d1/README.md`, biases). The +6.5 points over the summary may be partly that bias.
- One answering family so far. The second (gpt-oss-120b answering, Gemini judging) is running on Groq's free tier.

Not yet measured: a second answering family, larger budgets, and whether `--filter-known` (dropping probes models
answer without context) changes the comparison with no context.

### 2026-10-22: without a budget, and a second repository: no held-out gain either

With a paid key, refine was run without a budget, so that every added claim reaches the answering model.
gemini-3.8-flash wrote the claims and answered; gpt-oss-20b judged. Same deterministic hold-out split.

| File | Training before -> after | **Held-out before -> after** | Claims added |
|---|---|---|---|
| this repository (`bench/a1/gemini.hcs`, 26 + 11 probes) | 38.5% -> 100.0% | **50.0% [27.3%-77.3%] -> 40.9% [18.2%-63.6%]** (misled 9.1% -> 18.2%) | 24 |
| pallets/itsdangerous (`bench/d1/hcs/pallets__itsdangerous.hcs`, 21 + 9 probes) | 90.5% -> 95.2% | **44.4% [11.1%-77.8%] -> 44.4%** | 2 |

Outputs: `bench/c2/a1-refine-nobudget.txt`, `bench/c2/a1-refined-nobudget.hcs`, `bench/c2/itsdangerous-refine.txt`,
`bench/d1/hcs/pallets__itsdangerous.refined.hcs`; model replies in `bench/c2/logs/`. Cost: 670,299 input and 6,307
output tokens on gemini-3.8-flash.

**Conclusion for C2: refine does not improve held-out fidelity on either repository.** On this repository it reached
100% on the training probes in one round and made the held-out probes slightly worse, with more wrong answers:
claims written to answer specific failed questions do not carry over to other questions, and can mislead. On
itsdangerous there was little to fill (90% training fidelity before) and nothing changed on the held-out probes.
With 9 to 11 held-out probes the intervals are very wide, so a small real effect in either direction cannot be
excluded, but there is no evidence of a gain. `refine` stays available as an experiment; the README says it did not
generalize. Ideas not tried: asking the writer for claims about the whole cited symbol rather than the question,
and ranking added claims by ablation over many probes.

### 2026-10-22: independent probes and an agentic mode

Two weaknesses of the run above were addressed. **Independent probes**: 144 new probes (`bench/d1/probes/`), written
by gemini-3.8-flash from each source chunk alone in calls that never saw the compiled claims, each kept only when its
quote is found in the source (`node bench/d1/d1.mjs probes`). **Agentic conditions**: the model may ask once for
more source before answering, with the same reading budget (3,000 tokens) on both sides: `hcs+expand` reads the
exact source behind up to 3 claims (what the MCP tool `hcs_expand` returns), `summary+open` opens up to 2 files
named in the naive summary. Same answerer (gemini-3.8-flash) and judge (gpt-oss-20b). Raw results:
`bench/d1/results/*/*--independent/`; table: `bench/d1/results.md`.

Pooled over 144 independent probes (paired bootstrap, 95% CI); "unknown" are the 103 probes the model could not
answer without context:

| Condition | Fidelity | On unknown probes |
|---|---|---|
| HCS context (2,000 tokens) | 31.9% [24.3-39.6] | 27.2% [19.4-35.9] |
| Naive summary (2,000 tokens) | 25.7% [18.8-32.6] | 26.2% [18.4-35.0] |
| README (cut to 2,000 tokens) | 10.8% [5.9-16.0] | 5.3% [1.5-9.7] |
| No context | 27.4% [20.8-34.7] | 0.0% |
| HCS + read claims' source | 51.4% [43.1-59.7] | 50.5% [40.8-60.2] |
| Summary + open files | 48.6% [41.0-56.3] | 43.2% [34.0-52.4] |

| Difference (points) | All probes | Unknown probes |
|---|---|---|
| HCS minus naive summary | +6.3 [-1.4, +13.9] | +1.0 [-7.8, +9.7] |
| HCS minus README | **+21.2 [+13.9, +28.8]** | **+21.8 [+13.1, +31.1]** |
| HCS + source minus summary + files | +2.8 [-7.3, +12.5] | +7.3 [-3.9, +18.0] |
| HCS + source minus HCS alone | **+19.4 [+13.2, +25.7]** | **+23.3 [+15.5, +32.0]** |
| Summary + files minus summary alone | **+22.9 [+16.3, +30.2]** | **+17.0 [+10.2, +24.3]** |

The model asked for more source on 49 of 144 questions with HCS (exact claim sources) and on 75 of 144 with the
summary (whole files). Per repository the agentic comparison goes both ways: HCS + source ahead on kilo (75.0% vs
41.7%) and ky (53.3% vs 26.7%), behind on itsdangerous (53.3% vs 80.0%), cobra (40.0% vs 48.3%) and anyhow (40.0% vs
45.0%).

What this shows:

- With probes written apart from the claims, **the HCS context is not measurably better than a naive summary of
  the same size**, in either setting (static or agentic). The +9.8 points on unknown probes measured earlier with
  the compiler's own probes came from that bias; it is +1.0 here.
- **HCS clearly beats the repositories' own README and AGENTS.md** (+21 points), with any probe set.
- **Reading source matters far more than the form of the summary**: one round of retrieval adds about 20 points
  to either context. HCS gets there with fewer reads (its anchors point to the exact code), but not to a
  significantly higher score.
- Limits: one answering model, one judge, 144 probes; the independent probes come from the same model family as
  the compiler; one retrieval round only.

Conclusion for the project: what HCS demonstrably adds is not better compression but verifiability (every claim
cites hashed source), drift detection in CI, and precise retrieval through anchors. Answer quality is about the
same as a naive summary of the same size, and far better than hand-written README or AGENTS.md files.

### 2026-10-22: the render was the handicap: compact profile

Diagnosis of the run above (no model calls, `node dist/src/cli.js stats bench/d1/hcs/<repo>.hcs`): in the 2,000-token
`full` render, anchors took 31% to 39% of the tokens, and selection by importance then document order left whole
files without a claim (cobra: 8 of 15 files covered at 2,000 tokens, 1 of 15 at 500). Real token counts by Gemini
also showed that the estimate overcounts prose: the naive summaries were 1,272 to 1,714 real tokens against about
1,900 for the HCS render, so the earlier comparison did not handicap HCS on size. The fix is the `compact` render
profile (SPEC 6.2): claims as `id: text`, then one claim per source file in turn.

All conditions were re-scored together with the final decoder instructions (results tagged `v2`, in
`bench/d1/results/*/*--independent--v2/`; no-context results reused, since that prompt does not use the decoder;
analysis output `bench/d1/analysis-v2.txt`; 1,215 Gemini requests, 2,485,528 input tokens). 144 independent probes,
103 of them unknown without context:

| Condition | Fidelity [95% CI] | On unknown probes |
|---|---|---|
| **HCS, compact profile** | **43.8% [36.1-52.1]** | **39.8% [31.1-49.5]** |
| HCS, full profile | 32.6% [25.0-40.3] | 28.2% [20.4-36.9] |
| Naive summary, same budget | 24.7% [18.1-31.3] | 24.3% [16.5-33.0] |
| No context | 27.4% [20.8-34.7] | 0.0% |
| README, cut to the budget | 10.4% [5.6-15.3] | 4.9% [1.0-9.7] |
| **HCS compact + read claims' source** | **58.3% [50.0-66.0]** | **56.3% [46.6-65.0]** |
| HCS full + read claims' source | 50.7% [43.1-59.0] | 49.5% [39.8-58.3] |
| Summary + open files | 48.6% [41.0-56.3] | 43.7% [34.0-53.4] |

| Paired difference (points) | All probes | Unknown probes |
|---|---|---|
| Compact minus full | **+11.1 [+4.9, +18.1]** | **+11.7 [+3.9, +20.4]** |
| Compact minus naive summary | **+19.1 [+10.4, +28.1]** | **+15.5 [+5.8, +26.2]** |
| Compact minus no context | **+16.3 [+5.9, +26.7]** | **+39.8 [+31.1, +49.5]** |
| Compact minus README | **+33.3 [+25.0, +41.7]** | **+35.0 [+25.2, +45.6]** |
| Compact + source minus summary + files | +9.7 [-0.7, +20.1] | +12.6 [0.0, +24.3] |

Per repository, compact versus naive summary: kilo 50.0 vs 25.0, itsdangerous 66.7 vs 43.3, anyhow 43.3 vs 16.7,
cobra 33.3 vs 18.3, ky 26.7 vs 20.0. With one round of reading, compact + source read more source on 45 of 144
questions against 77 for summary + files.

What this shows: with the compact profile, the HCS context clearly beats a naive summary of the same budget, no
context and the README, on probes written apart from the claims; the earlier "no better than a summary" came
mostly from the render. In the agentic setting it is ahead with fewer reads, but the interval still touches zero.

Limits, to be read with the numbers: the compact profile was designed after looking at these five repositories
(its rules are generic, anchors and coverage, but it has not yet been confirmed on fresh repositories); one
answering model (gemini-3.8-flash), which also compiled the files and wrote the independent probes; one judge
(gpt-oss-20b); 144 probes. Next: the same comparison with a second answering family and on repositories not used to
design the profile.

### 2026-10-22: confirmation on three new repositories (pre-registered)

The protocol was committed before any model call on these repositories (`bench/d1/CONFIRMATION.md`, commit
51204e5): expressjs/express, psf/requests and sirupsen/logrus, the same pipeline as the v2 run, and one primary
endpoint fixed in advance: `hcs-compact` minus `summary`, pooled, confirmed only if its 95% interval is entirely above
zero. Analysis output: `bench/d1/analysis-confirmation.txt`; raw results under
`bench/d1/results/{expressjs__express,psf__requests,sirupsen__logrus}/*--independent--v2/`.

| Condition (gemini-3.8-flash answers, gpt-oss-20b judges) | Fidelity [95% CI], 90 probes | On the 56 unknown probes |
|---|---|---|
| **HCS, compact profile** | **46.7% [36.7-56.7]** | **48.2% [35.7-62.5]** |
| HCS, full profile | 32.2% [23.3-42.2] | 37.5% [25.0-50.0] |
| Naive summary, same budget | 27.8% [18.9-37.2] | 24.1% [13.4-35.7] |
| No context | 37.2% [27.8-47.2] | 0.0% |
| README, cut to the budget | 10.0% [4.4-16.7] | 8.9% [1.8-17.9] |
| HCS compact + read claims' source | 62.8% [52.2-72.2] | 64.3% [51.8-76.8] |
| Summary + open files | 51.7% [41.1-62.2] | 52.7% [40.2-64.3] |

- **Primary endpoint, compact minus naive summary: +18.9 points [+7.2, +30.6]: confirmed** (+24.1 [+8.9, +39.3] on
  unknown probes). The five design repositories gave +19.1 [+10.4, +28.1].
- Secondary: compact minus full +14.4 [+6.7, +23.3]; minus README +36.7 [+26.7, +47.8]; minus no context +9.4
  [-5.0, +23.9] (not significant here: these are well-known libraries; on unknown probes +48.2); compact + source
  minus summary + files +11.1 [-2.2, +24.4] (33 and 30 reads of 90).
- Per repository, compact versus summary: express 43.3 vs 31.7, requests 43.3 vs 20.0, logrus 53.3 vs 31.7.

**Second answering family (pre-registered secondary endpoint).** mistral:ministral-14b-latest answers, gemini-3.8-flash
judges, conditions `hcs-compact` and `summary`, same probes and budget. The family was changed from gpt-oss-20b
before any call with the new model, because Groq's free tier covered only part of one repository per day (amendment
in `bench/d1/CONFIRMATION.md`). The abandoned gpt-oss-20b run stopped on express after `summary` 30/30 probes (13
correct) and `hcs-compact` 13/30 (7 correct); it is kept under `results/expressjs__express/groq_*` and counts for
nothing. Analysis: `node bench/d1/paired.mjs` (output `bench/d1/analysis-confirmation-family2.txt`, which reproduces
the family 1 numbers above from their raw results).

| ministral-14b answers, Gemini judges | Fidelity [95% CI], 90 probes |
|---|---|
| **HCS, compact profile** | **43.3% [33.9-53.3]** |
| Naive summary, same budget | 27.2% [18.3-36.7] |

- **Compact minus naive summary: +16.1 points [+3.9, +27.8]**, entirely above zero, so the result holds with a
  second, smaller answering model from another family. Per repository: express 48.3 vs 38.3, requests 38.3 vs 20.0,
  logrus 43.3 vs 23.3.

Still open: one model (gemini-3.8-flash) compiled the files, wrote the probes and the summaries, and judges family 2;
the second family on the five design repositories is running.

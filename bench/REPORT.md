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

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

No fidelity number yet: see the next sections.

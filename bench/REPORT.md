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

Status: blocked on environment configuration. No compile or score run yet, so no fidelity numbers.

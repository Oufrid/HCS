# Example: a small shop

A tiny project in TypeScript, Python and Markdown, with every HCS artifact next to it. It is the project used by
the [tutorial](../../docs/tutorial.md). Everything here was produced by real commands on free tiers on
2026-10-21; nothing was edited by hand except the source files, `AGENTS.md` and the conversation.

| File | What it is | Made with |
|---|---|---|
| `src/pricing.ts`, `src/orders.ts` | Prices, shipping, discount codes, order states (TypeScript) | written for the example |
| `worker/refunds.py` | Nightly refund worker (Python) | written for the example |
| `docs/policy.md` | The shop's policies | written for the example |
| `shop.hcs` | The compiled context: 41 claims, 12 probes, one certificate | `hcs compile`, `hcs score --write` |
| `score-output.txt` | The output of that `score` run | `hcs score` |
| `AGENTS.md` | A hand-written agent file, with one broken reference and one wrong fact on purpose | written for the example |
| `audit-output.txt` | Its audit: references, then a score against the probes of `shop.hcs` | `hcs audit --probes` |
| `session/conversation.json` | A short design conversation (written for the example, not a real chat) | written for the example |
| `session/session.hcs` | That conversation as a portable, anchored session state | `hcs snapshot` |
| `.mcp.json` | MCP configuration for Claude Code (project scope) | written for the example |

## How each artifact was made

Run from this directory, with the CLI built at the repository root (`hcs` is `node ../../dist/src/cli.js`):

```bash
hcs compile src worker docs --model groq:openai/gpt-oss-120b --reasoning-effort low --rpm 8 --title Shop -o shop.hcs
hcs score shop.hcs --model gemini:gemini-3.1-flash-lite --judge groq:openai/gpt-oss-120b --rpm 8 --concurrency 1 --write
hcs audit AGENTS.md --probes shop.hcs --model gemini:gemini-3.5-flash-lite --judge groq:openai/gpt-oss-120b --rpm 8 --concurrency 1
cd session && hcs snapshot conversation.json --model groq:openai/gpt-oss-120b --reasoning-effort low --rpm 8 --max-probes 6 -o session.hcs
```

`AGENTS.md` was left out of `compile` on purpose: it contains a false statement (a 30-day refund window), and a
compiler would have copied it into claims with a valid quote. HCS proves that a claim's words are in a source, not
that the source is right.

## What the results say (and do not say)

- **Compile:** 33 claims and 12 probes proposed, none rejected by quote verification, plus 8 overview claims. The
  rendered context is about 1,800 tokens for about 1,300 tokens of source: on a project this small, HCS does not
  compress, it organizes. Compression matters on large projects (7% of the source in `bench/REPORT.md`, A1).
- **Score:** fidelity 75.0%, 95% CI 50.0%-100.0%, on 12 probes; 3 probes answered "unknown", 0 wrong. The three
  missed details (the exact error message, the allowed next statuses after `paid`, the status literals) are in
  the source but not in any claim: the claims summarize them. With 12 probes the interval is very wide; this is a
  demonstration, not a measurement. No baseline was run (`--baseline` would have doubled the requests on a
  20-requests-per-day Gemini model).
- **Audit:** `AGENTS.md` has 1 broken reference (`src/payments.ts`) and scores 0.0% on the same 12 probes (every
  answer "unknown"): it is short and says nothing the probes ask. It was scored by a different Gemini model than
  `shop.hcs`, because of the daily quota, so the two numbers are not a paired comparison. The audit does not catch
  the wrong refund window: no probe asks about it.
- **Snapshot:** 14 claims and 3 probes. It kept the decision, the plan, the constraint on the restocking fee and
  the deadline, but dropped the numbers that motivated the decision (9 of 41 requests) and the open question at
  the end (whether the discount counts toward the threshold). Read a snapshot before relying on it.

## Try it

```bash
hcs check shop.hcs                       # every claim still matches its sources
hcs render shop.hcs --budget 500         # what a small-context model would see
# edit worker/refunds.py: set REFUND_WINDOW_DAYS = 30, then
hcs check shop.hcs                       # c5, c34 and p4 are stale and the certificate is outdated (exit 1)
git checkout worker/refunds.py           # undo
```

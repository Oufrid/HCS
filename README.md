# HCS: Holographic Context Standard

**Context files for LLMs that can prove what they say, notice when they go stale, and measure what they lose.**

Everyone compresses context for language models: `AGENTS.md`, `CLAUDE.md`, session summaries, project briefs. All of these share three blind spots:

1. **Nobody knows what the summary lost.** There is no number for it.
2. **They rot silently.** The code or document changes, the summary does not, and the model believes something false.
3. **They cannot be traced.** When a summary asserts something, nothing says where it came from.

HCS fixes all three with a small open format and a CLI:

| | What HCS does | Needs an LLM? |
|---|---|---|
| **Traceable** | Every claim cites `path:lines` of its source, so a model knows where to read instead of guessing. | no |
| **Verifiable** | Every citation carries a hash. `hcs check` detects stale claims in CI, follows code that only moved, and fails when meaning may have changed. | no |
| **Measured** | The file ships test questions whose answers are proven verbatim in the source. `hcs score` reports the *fidelity* of the context for a given model, the baseline without context, and how often the context *misled* the model. | yes (any) |

It works with any material (code in any language, docs, research notes, chat transcripts) and with any model: OpenAI, Anthropic, Gemini, or any local model through Ollama or an OpenAI-compatible server. A rendered HCS context is plain text, so it also works in any chat UI.

```
$ hcs check project.hcs
project.hcs: 64 claims, 30 probes
  claims: 61 ok, 2 moved, 1 stale
  probes: 30 ok
  moved    c14    src/api/router.ts:88-102 -> lines 91-105
  STALE    c31    src/billing/plans.ts:12-30  anchored text changed
  certificate openai:gpt-4o-mini fidelity=0.883: OUTDATED (context changed since it was scored)
FAIL: 1 item(s) no longer match their sources. ...
```
*(Example output.)*

> Status: **v0.1, early**. The format and the deterministic engine (`check`, `seal`, `render`, `audit`) are complete and tested. The LLM features (`compile`, `score`, `snapshot`) are implemented and tested against mock OpenAI/Anthropic servers. They have not yet been benchmarked on real models at scale. Published benchmark numbers will come from `bench/`, not from claims in this README.

---

## Install

Requires Node.js ≥ 18.17. Zero runtime dependencies.

```bash
git clone https://github.com/Oufrid/HCS.git && cd HCS
npm install && npm run build
npm link            # puts `hcs` on your PATH
```

## Quick start

### 1. Compile a context file from your project

```bash
export OPENAI_API_KEY=...            # or ANTHROPIC_API_KEY, GEMINI_API_KEY, or run Ollama locally
hcs compile --model openai:gpt-4o-mini -o project.hcs
```

The compiler reads every text file (it honors `.gitignore` and `.hcsignore`). It asks the model for claims and probes, each backed by an **exact quote**, and **discards every item whose quote is not actually in the source**. That is a mechanical guard against hallucinated summaries. It then seals every anchor with a hash.

```
wrote project.hcs: 64 claims, 30 probes from 41 files (41 compiled)
  rejected by quote verification: 7/198 claims, 3/95 probes
```
*(Example output.)*

### 2. Measure it

```bash
hcs score project.hcs --model ollama:llama3.1 --baseline --write
```

```
with context     fidelity  81.7%   misled   5.0%   abstained  13.3%   (30 probes)
without context  fidelity  10.0%   misled  31.7%   abstained  58.3%   (30 probes)
gain             71.7 points
not recovered from the context:
  p7 [unknown] Which header carries the idempotency key?
  ...
```
*(Illustrative output format. Your numbers depend on your project and model.)*

`--write` stores a **certificate** in the file. The certificate is bound to a digest of the exact context that was scored, and `hcs check` reports it as outdated as soon as that context changes.

Use `--budget 1000` to score what a small-context model would see. `--judge` grades with a different model than the one answering.

### 3. Use it with any LLM

```bash
hcs render project.hcs --decoder --budget 2000 | pbcopy     # paste into any chat
```

### 4. Keep it true

```bash
hcs check project.hcs          # in CI: exit 1 if any claim's source changed
hcs seal project.hcs           # follow code that only moved; hash new hand-written anchors
hcs compile --model ... --update   # re-read only changed files; keep everything still verified
```

## Hand-written claims

The compiler is optional. Rules that no tool can infer (*"never log card numbers"*) are the most valuable context, so write them yourself and anchor them:

```
[claims]
## Security
#no-pan[manual] Never log full card numbers; mask all but the last 4 digits.
  > src/log/redact.ts:5-30
```

Then run `hcs seal project.hcs` to hash the anchor. From then on, `hcs check` tells you when `redact.ts` changes and the rule needs a human look. Incremental compiles never delete `manual` claims.

## Session hand-off between LLMs

```bash
hcs snapshot conversation.json --model anthropic:<model> -o session.hcs
hcs render session.hcs --decoder        # paste into another LLM to continue
```

`snapshot` accepts OpenAI/Anthropic-style message arrays, `{messages: [...]}`, ChatGPT exports, or a plain `.md`/`.txt` transcript. It writes an anchored transcript next to the `.hcs` file, so every claim about the conversation (decisions, constraints, next steps) cites the message it came from. With `hcs score` you can measure what survived the hand-off.

## Audit the context files you already have

HCS does not replace `AGENTS.md`, `CLAUDE.md` or your README. It can check them:

```bash
hcs audit AGENTS.md                                      # broken file references (no LLM)
hcs audit AGENTS.md --probes project.hcs --model M --baseline   # how much does AGENTS.md actually convey?
```

This gives you a fidelity number for *any* context file, measured with the same verified probes.

## In CI (GitHub Actions)

```yaml
- uses: actions/checkout@v4
- uses: Oufrid/HCS@main
  with:
    file: project.hcs
    strict: "false"      # "true" also fails on unsealed anchors
```

## Commands

| Command | LLM | Purpose |
|---|---|---|
| `hcs init` | no | Create an empty file for hand-written claims |
| `hcs validate <f>` | no | Syntax check |
| `hcs check <f>` | no | Verify all anchors and certificates (exit 1 on stale/missing) |
| `hcs seal <f>` | no | Hash unsealed anchors, follow moved ones, `--rehash` accepts changes |
| `hcs render <f>` | no | Print the context block (`--budget`, `--decoder`) |
| `hcs stats <f>` | no | Sizes, compression ratio, claims kept per budget |
| `hcs audit <file>` | optional | Broken references; fidelity of any context file |
| `hcs compile [paths]` | yes | Sources → anchored claims + verified probes (`--update` for incremental) |
| `hcs score <f>` | yes | Fidelity, baseline, misled rate; `--write` adds a certificate |
| `hcs snapshot <conv>` | yes | Conversation → portable, anchored session state |

Models are written `provider:model`:

| Provider | Variables |
|---|---|
| `openai:` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (any OpenAI-compatible API: OpenRouter, Groq, Mistral, vLLM, LM Studio…) |
| `anthropic:` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| `gemini:` | `GEMINI_API_KEY` |
| `ollama:` | `OLLAMA_HOST` (default `http://localhost:11434`) |

## Decoder prompt

`hcs render --decoder` prepends these instructions. They are deliberately short and vendor-neutral:

```
You are given an HCS context block: a set of short, numbered claims about a body of source material
(code, documents or a conversation). Each claim cites where it comes from as path:lines.

Rules:
1. Treat the claims as true summaries of the cited sources. They are deliberately incomplete.
2. If a question needs a detail the claims do not state, say so and name the cited source to read.
   Never invent the missing detail.
3. When you rely on a claim, you may cite its id (e.g. c12) or its source.
4. Claims marked (unverified) may be out of date: their source changed since they were written.
```

## What HCS is not

- **Not lossless.** No summary is. HCS *measures* the loss instead of hiding it.
- **Not magic compression.** Claims are plain sentences. Symbols and emoji do not make a model understand more per token. Choosing *what* to keep is what saves tokens.
- **Not always smaller.** For a tiny project, the source itself may be shorter than its context file. HCS pays off when the material is larger than what you want to put in a prompt.
- **Not a judge-free metric.** Exact matches are graded deterministically; everything else is graded by an LLM judge. Use `--judge` with a different model to limit self-grading bias, and read the per-probe output.

## How it compares

See [PRIOR_ART.md](PRIOR_ART.md). In short: drift checkers, prompt compressors, summary evaluators and context files each exist separately. HCS combines anchored claims, hash verification, extractively verified probes and context-bound fidelity certificates in one portable file format that any model can read.

## Repository layout

```
SPEC.md         the format, normative
src/            CLI and library (TypeScript, no runtime dependencies)
test/           node:test suite, including mock OpenAI/Anthropic servers
bench/          reproducible benchmark harness
project.hcs     HCS describing itself (checked in CI)
action.yml      GitHub Action
```

## Contributing

Issues and PRs are welcome, especially benchmark results on real projects and models, other language front-ends, and spec feedback. Run `npm test` before submitting. If your change affects a claim in `project.hcs`, `npm run check:self` will tell you.

## License

MIT

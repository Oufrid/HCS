# From zero to a certified context in 10 minutes

You will install HCS, compile a context file for a small project with a free model, check it, break it on
purpose, score it, and hand it to an assistant. This page was tested by following it in a fresh session (see the
end). Model output differs between runs, so your numbers will differ from the ones quoted.

You need Node.js 18.17 or newer, git, and a free API key from [Groq](https://console.groq.com/keys) (a
[Gemini](https://aistudio.google.com/apikey) key as well is better, for an independent judge). Free tiers may use
your prompts: only compile code you are allowed to share. The example project here is public.

## 1. Install (1 minute)

```bash
npm install -g @oufrid/hcs-cli   # puts `hcs` on your PATH
git clone https://github.com/Oufrid/HCS.git
cd HCS                           # for the example project used below
hcs --version
```

The CLI has no runtime dependencies. To build it from the clone instead (for development): `npm install && npm run
build`, then `npm link` (or, if npm link is not allowed, `alias hcs="node $PWD/dist/src/cli.js"`). `npm install`
only fetches development tools (TypeScript, optional parsers for the tests).

## 2. Connect a model (1 minute)

```bash
export GROQ_API_KEY=...          # your key; HCS never prints it
export GEMINI_API_KEY=...        # optional
hcs models groq                  # the model ids your key can use
```

Use only ids from that list (it also shows speech and safety models, which cannot be used here). On 2026-10-21 it included `groq:openai/gpt-oss-120b` and `groq:qwen/qwen3.8-27b`;
yours may differ. Free tiers have rate limits, so always pass `--rpm 8` (8 requests per minute) to LLM commands.

## 3. Compile a context file (2 minutes)

Copy the example project somewhere outside the repository, so that you can edit it freely:

```bash
mkdir -p ~/hcs-tutorial
cp -r examples/shop/src examples/shop/worker examples/shop/docs ~/hcs-tutorial/
cd ~/hcs-tutorial
hcs compile src worker docs --model groq:openai/gpt-oss-120b --reasoning-effort low --rpm 8 --title Shop -o shop.hcs
```

`--reasoning-effort low` keeps reasoning models from spending their whole output budget thinking. The command
reports how many claims and probes it wrote, and how many the model proposed that were rejected because their
quote is not in the source. Its last line suggests a score command: use the one in step 5 instead. Open `shop.hcs`: every claim (`#c12 ...`) is followed by anchors (`> src/pricing.ts::shippingFee #52d3f81cc48d`)
that name the exact code it comes from, with a hash of that code. Probes (`?p3 ...`) are test questions with
answers proven against the source.

## 4. Check it, then break it (1 minute)

```bash
hcs check shop.hcs               # "OK: every claim still matches its sources." No LLM involved.
```

Now change a fact. Edit `worker/refunds.py` and set `REFUND_WINDOW_DAYS = 30`, then:

```bash
hcs check shop.hcs               # the claims and probes citing that line are STALE; exit code 1
```

This is what CI catches: a context file that no longer matches the code. Put the value back to 14 and check
again: everything is `ok`. When a change is intended, read the stale claims and probes, fix a claim's text or a
probe's answer (its `= 14` line) if needed, then accept the new code with `hcs seal shop.hcs --rehash --ids
c5,c34,p4` (use the ids `check` printed; yours may differ).

## 5. Score it (3 minutes)

A score says how much of the project a model actually recovers from the context. One model answers the probes
with only the context; a model from another family judges the answers.

```bash
hcs score shop.hcs --model gemini:<model id> --judge groq:openai/gpt-oss-120b --rpm 8 --concurrency 1 --write
```

With only a Groq key, use two families there, for example `--model groq:qwen/qwen3.8-27b --judge
groq:openai/gpt-oss-120b`. The output gives the fidelity with a 95% confidence interval, the share of wrong
answers (`misled`) and of answers "unknown" (`abstained`), and lists the probes the context did not answer. The
judge is only asked about answers that are neither exact matches nor "unknown", so it may make few requests. With about 12 probes the
interval is wide (in our run: 75%, CI 50% to 100%); HCS says so. Add `--baseline` to also ask the probes
without any context, which shows what the context adds; it doubles the requests.

`--write` stores a certificate in the file: `!score model=... fidelity=... digest=...`. The digest binds it to the
exact rendered context: `hcs check` now prints it as `current`, and as `OUTDATED` once a claim changes (a
warning: an outdated certificate does not make `check` fail, a stale claim does).

If a free quota runs out mid-run, HCS stops, keeps every answered probe, and says when to rerun the same command
to resume.

## 6. Use it (1 minute)

Paste the context into any chat model:

```bash
hcs render shop.hcs --decoder            # instructions for the model, then the claims
hcs render shop.hcs --budget 500         # for a small context window: the most important claims first
```

Or give it to an agent through MCP, so that it reads the claims first and the exact cited code only when it needs
a detail. For Claude Code, put this in `.mcp.json` at the project root:

```json
{ "mcpServers": { "shop": { "command": "hcs", "args": ["serve", "shop.hcs"] } } }
```

Other clients are in [mcp.md](mcp.md).

## 7. Keep it true (1 minute)

Commit `shop.hcs` with your code and verify it on every push. No LLM and no secret are needed:

```yaml
- uses: actions/checkout@v4
- uses: Oufrid/HCS@main
  with:
    file: shop.hcs
```

After code changes, `hcs compile ... -o shop.hcs --update` re-reads only the files whose claims went stale, and
keeps hand-written claims.

## Where to go next

- Audit the agent files you already have: `hcs audit AGENTS.md` lists broken file references, and
  `--probes shop.hcs --model ...` scores the file on the same probes ([example](../examples/shop/README.md)).
- Write claims by hand for rules that matter (`hcs init`, then `hcs seal`).
- Save a conversation for another model: `hcs snapshot conversation.json --model ...`.
- Sign certificates (`hcs keygen`, `score --sign`), curves (`hcs curve`), and the [FAQ](faq.md) for the limits.

## How this page was tested

On 2026-10-21 a fresh agent session with no prior context followed this page from a clean clone, with the Groq
models named above (step 5 with `--model groq:openai/gpt-oss-20b --judge groq:qwen/qwen3.8-27b`). Every step
worked as written: 40 claims and 12 probes compiled (1 claim rejected), 3 items stale after the edit in step 4,
fidelity 75.0% (95% CI 50.0%-100.0%) in step 5. About 3 minutes of commands, 8 to 10 minutes with reading. The
places where it had to guess (probe ids in step 4, the `abstained` column, the score hint printed by `compile`)
were fixed on this page and in the CLI.

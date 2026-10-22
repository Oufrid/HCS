# D1: public benchmark (protocol)

Five public repositories, pinned in `repos.json`, in five languages and three sizes, plus this repository (A1):

| Repository | Language | Paths compiled | Approx. source tokens |
|---|---|---|---|
| antirez/kilo | C | `kilo.c`, README | 13k |
| pallets/itsdangerous | Python | `src`, README, `docs` | 16k |
| dtolnay/anyhow | Rust | `src`, README | 56k |
| spf13/cobra | Go | top-level non-test `.go` files except `bash_completionsV2.go` (a Bash template the compiler could not finish), README | 61k |
| sindresorhus/ky | TypeScript | `source`, readme | 76k |

Tests are left out to fit free tiers; the sizes are HCS's own token estimates.

## Steps

```bash
npm run build
node bench/d1/d1.mjs prepare                                    # clone at the pinned commits (bench/.work/d1)
node bench/d1/d1.mjs compile   --model <compiler> --reasoning-effort low --rpm 8
node bench/d1/d1.mjs summarize --model <compiler> --rpm 8      # the naive-summary baseline, same model
node bench/d1/d1.mjs score --model <answerer> --judge <judge from another family> --rpm 8
node bench/d1/d1.mjs report                                     # results.md and results.json
```

Each step resumes where a quota stopped it (exit code 3); rerun it later. Raw data is committed: the compiled files
(`hcs/`), the summaries (`summaries/`), every probe's answer and verdict (`results/`) and the model replies of the
compile (`logs/`).

## Conditions

All conditions are scored on the same probes (the verified probes of the compiled file), by the same answerer and
judge, so differences are paired:

- `hcs`: the compiled context rendered at a 2,000-token budget;
- `none`: no context;
- `readme`: the repository's README, cut at the last whole line within the same budget when it is longer (ky's is
  about 22,000 tokens, more than a Groq free-tier request allows); its full size is recorded;
- `agents`: its AGENTS.md or CLAUDE.md, when there is one (only ky has one);
- `summary`: a naive summary of the same sources by the compiling model, each chunk summarized in proportion to
  its size, concatenated and cut to the same 2,000-token budget.

At least two answering model families are used, each judged by a model of another family.

## Known biases (to be repeated in the report)

- The probes are written by the compiling model from the same chunks it compiles. This favors `hcs` over every
  baseline: a fact the compiler chose to ask about is likely a fact it chose to state. The `readme` and `summary`
  baselines are measured on questions they were not written for.
- The README is part of the compiled sources, so probes about it exist; `readme` is the only baseline with an
  advantage there.
- Several free-tier models with different quotas may be needed for one step; the model of each file is recorded in
  its `@generator` header and in the summaries.
- Few probes per repository (up to 30, to fit free tiers) give wide intervals; differences are reported with paired
  bootstrap CIs.
- Cost on free tiers: about 30 probes x 5 conditions x 2,000 tokens per repository and answerer, roughly 1M tokens
  per answering model for the five repositories, or about five days of one Groq model's daily quota. The runs are
  spread over days and resumed.

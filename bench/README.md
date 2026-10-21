# Benchmark

`run.mjs` clones public repositories at their current commit, compiles an `.hcs` file with the first `--model`, then scores it with each model **with and without** the context. Every run appends one JSON line per model to `results.jsonl`: repository, commit, models, budget, fidelity, baseline, misled rate, probe count and context size.

```bash
npm run build
node bench/run.mjs --model openai:gpt-4o-mini --model ollama:llama3.1 --judge anthropic:<model> --budget 2000
```

No results have been published yet. Numbers should only be quoted together with the `results.jsonl` lines they come from.

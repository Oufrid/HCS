# HCS conformance suite

Language-agnostic test cases for implementations of [SPEC.md](../SPEC.md). A format with one implementation is a
tool; these cases are what a second implementation must reproduce. Two implementations pass them in CI: the
TypeScript reference (`npm run conformance`) and the Python package (`python -m unittest discover -s python/tests`).

## Layout

Each directory in `cases/` is one case:

| File | Meaning |
|---|---|
| `case.json` | `{"op": ..., "description": ..., "args": {...}}` |
| `input.hcs` | The document under test (for `parse`, `serialize`, `check`, `seal`, `render`, `digest`). |
| `src/` | Source files. Documents use `@root src`; `symbols`, `find` and `hash` resolve paths against `src/`. |
| `expected.json` | The result an implementation must produce, compared as JSON (object key order does not matter). |
| `input.template.hcs`, `before/` | How `input.hcs` was made: anchors marked `#HASH_*` were sealed against `before/` (the sources when the claim was written), then `src/` changed. Implementations only read `input.hcs`. |

Run each case on a copy outside any git repository: discovering files for cross-file symbol moves must not depend
on `git ls-files`.

## Operations

| `op` | Input | Expected output |
|---|---|---|
| `parse` | `input.hcs` | `{"ok": true, "document": D}` or `{"ok": false, "line": N}` (the line of the syntax error, 0 for the whole file; messages are free). `D` has `headers`, `meta`, `claims` (`id`, `text`, `tags`, `anchors`, optional `section`), `probes` (`id`, `question`, `answer`, `anchors`, `claims`, optional `tags`) and `certificates` (`fields`). An anchor has `path` and optional `symbol`, `start`, `end`, `hash`; absent values are omitted, not null. |
| `serialize` | `input.hcs` | `{"text": T}`: the canonical serialization of the parsed document. |
| `symbols` | `args.file` in `src/` | `{"symbols": [{"name", "start", "end"}]}`: every symbol with its qualified name, in order. |
| `find` | `args.queries`: `[file, symbol]` pairs | `{"results": [range or null]}`. |
| `hash` | `args.anchors`: anchor strings | `{"hashes": [hash or null]}`: the hash each anchor should carry now. |
| `check` | `input.hcs` + `src/` | `{"items": [{"kind", "id", "status", "anchors": [{"status", "relocated"?}]}]}`, claims then probes. `relocated` is `{"start", "end"}` or `{"path", "symbol"}`. Detail messages are free. |
| `seal` | `input.hcs` + `src/`, `args.rehash`, `args.ids` | `{"result": {"sealed", "relocated", "rehashed"}, "text": T}`: counts and the serialized document. Headers are not touched. |
| `render` | `input.hcs` + `src/`, `args.keepStale`, `args.anchors`, `args.budget` | `{"text": T}`, with claim statuses from `check`. |
| `digest` | `input.hcs` + `src/` | `{"certificates": [{"digest", "current"}]}`: the digest of each certificate's context (stale and missing claims removed, at its `budget`) and whether it equals the recorded one. |

The token estimate used for budgets is part of the format's behavior: see `estimateTokens` in `src/render.ts`
(Python: `estimate_tokens`). It counts UTF-16 code units for characters outside the Basic Multilingual Plane.

## Changing the suite

1. Edit or add a case in `make_cases.py` (inputs only), run `python3 conformance/make_cases.py`.
2. `npm run build && node conformance/generate.mjs` writes `input.hcs` and `expected.json` with the reference.
3. Review the diff of every `expected.json`: the expected files are the standard, not a snapshot to accept.
4. Both implementations must pass: `npm run conformance` and the Python tests.

`cross_check.py` goes further than the fixed cases: it compares both implementations on every source file of this
repository (symbols), on its real `.hcs` files (statuses, renders, digests) and on 3,000 mutated `.hcs` files.

## Known limits of the reference behavior

These are fixed by the cases, so implementations agree on them; they may change in a future version of the spec:

- The symbol locator is heuristic. In Rust, `struct Point` and `impl Point` are two symbols named `Point`; the
  first one wins for `Point`, methods are found as `Point.new`.
- Regular expressions follow JavaScript semantics: `\w`, `\d` and `\b` are ASCII-only.

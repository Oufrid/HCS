# Contributing to HCS

Thanks for helping. HCS is small on purpose: a plain-text format, a zero-dependency CLI, and a Python reader. This
page says how to work on it and what a change needs before it is merged.

## What is most useful

- **Results on real projects.** Run `hcs compile` and `hcs score` on a public repository and open an issue with the
  "Benchmark result" template. Negative results are as welcome as positive ones.
- **Symbol-locator cases.** Code where `path::Symbol` anchors resolve to the wrong range, or not at all. A minimal
  source file is enough; it becomes a conformance case.
- **Spec feedback.** Ambiguities, missing cases, things a second implementation could not decide from `SPEC.md`.
- **Bug reports** with the command, the HCS version (`hcs --version`) and a minimal `.hcs` file.

## Setting up

```bash
git clone https://github.com/Oufrid/HCS.git && cd HCS
npm install && npm run build
npm test                                   # build + node:test, no network (mock model servers)
npm run conformance                        # language-agnostic cases against the TypeScript reference
python3 -m unittest discover -s python/tests
python3 conformance/cross_check.py         # Python and TypeScript agree on this repository and fuzzed inputs
node dist/src/cli.js check project.hcs --strict
```

Node >= 18.17 and Python >= 3.9. The development dependencies (TypeScript, and the optional tree-sitter packages
used by the tests) are never runtime dependencies.

## Rules for a change

1. **Everything in the repository is in English.**
2. **No runtime dependencies.** The CLI uses only Node.js built-ins. Optional back-ends are loaded at run time
   only when asked for (see `src/treesitter.ts`).
3. **Tests.** New behavior comes with a test in `test/*.test.ts` (`node:test`). Changes to parsing, hashing,
   symbols, rendering or verification also need a conformance case (`conformance/README.md`) that both
   implementations pass.
4. **`project.hcs` stays true.** This repository describes itself in HCS, and CI runs `check --strict`. If your change
   touches code a claim cites, `npm run check:self` fails: read the claim; if it still holds, run
   `node dist/src/cli.js seal project.hcs --rehash --ids <id>`, otherwise fix the claim first. New features get a
   hand-written claim anchored to the code that implements them.
5. **Honesty.** Never present illustrative numbers as results. Label example output. Quote benchmark numbers only
   with the raw results file that produced them, and write down what did not work in `bench/REPORT.md`.
   Document limitations in `README.md` and `PRIOR_ART.md`.
6. **Keys.** Never print, log or commit an API key. Run models only on code you may send to that provider.
7. **Spec changes** follow the RFC process below.

Small, focused pull requests are easier to review. The pull-request template lists the checks.

## Changing the format

Anything that changes what a valid `.hcs` file is, how anchors hash, how a verifier decides a status, or what a
certificate means is a spec change. It needs an RFC in [`rfcs/`](rfcs/README.md) before code is merged.
Fixes to wording that do not change behavior can go straight to a pull request.

Readers must keep accepting older versions (`SPEC.md`, section 1), and writers emit the oldest version that can
express a document.

## Security issues

Do not open a public issue. Use GitHub's private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the MIT license of this repository.

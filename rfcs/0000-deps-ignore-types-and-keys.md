# RFC 0000: Ignore type-only and key-only names in dependency hashes

- Status: draft (not yet submitted as a pull request)
- Author: HCS maintainers
- Discussion: none yet

## Summary

Two exclusions in the dependency rule of SPEC section 5.5: a dependency on a TypeScript interface or type alias is
not counted, and a name that the anchored body uses only as an object key or as a property of another object is
not counted.

## Motivation

`review` is non-failing, so its cost is reviewer attention. On this repository's history, 35 of 38 review events
were not needed (`bench/REPORT.md`, C3). Two patterns account for many of them:

```ts
// src/compile.ts::compile uses the Probe interface; Probe gained an optional field: 3 reviews, none needed.
const probes: Probe[] = [];
// src/score.ts::scoreDocument writes `judge: ...` as a key; the judge() function changed: a review, not needed.
const fields = { model: opts.answerer.id, judge: judges.map((j) => j.id).join(",") };
```

## Specification

In SPEC 5.5, after the two rules that list dependencies, add:

> A name is not a dependency when (a) the symbol it names is a TypeScript `interface` or `type` alias, or (b) every
> occurrence of it in the body is either directly preceded by `.` (except after `this.` or `self.`), or directly
> followed by `:` or `?:` when the preceding non-space character is `{`, `,` or `(`.

## Compatibility

The `deps` hash of some anchors changes. A file sealed with the old rule then reads `review` (never `stale`) on
those anchors until it is re-sealed with `seal --rehash`. Readers that do not implement the new rule would report
`review` on files sealed with it. This needs a minor version (0.4) so that the rule is chosen by the file's version,
or a header naming the rule.

## Conformance

Update `deps-typescript` with an interface dependency and an object-key use, and add a case where a class used only
as a parameter type is still counted (unchanged behavior, documented).

## Alternatives

- A real parser (the optional tree-sitter back-end) would distinguish type positions and also exclude classes used
  only as types. It cannot be normative while it is optional.
- Depth-0 only (no dependency hashes) is already the default: `seal --deps` is opt-in.

## Evidence and limits

`bench/c3/history.mjs --variant types,keys`: 38 to 24 review events over 33 commits, the 3 needed ones kept. One
repository, one author, three needed events: not enough to claim recall is preserved in general.

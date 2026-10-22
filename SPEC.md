# HCS Specification: version 0.3

**Status:** draft. Feedback is welcome through issues.

- Changes in 0.3: probe tags and the `known` tag (§4), the `@known-filter` header (§4), two judges and the
  certificate fields `novel`, `novel-probes`, `judge-agreement`, `judge-kappa`, `judged` (§7).
  Compilers may ignore Markdown markup when verifying quotes, and may write an `@incomplete` header (§8).
  The `recorded` tag (§3) marks claims written by an agent. Certificates may form a fidelity-vs-budget curve
  (`curve`, `knee`, §7). Certificates may be signed with Ed25519 (`key`, `sig`, the `@keys` header, §7.1).
  The `@parser` header (§2, §5.2) names an optional symbol locator; the `tokenizer` certificate field (§7)
  says that `tokens` was counted by a real tokenizer.
- Changes in 0.2: symbol anchors (§5.2), the `suspect` tag (§3), and certificate fields `ci95`, `informative`, `runs` (§7).

Every valid 0.1 or 0.2 file is a valid 0.3 file. A writer SHOULD emit the oldest version that can express the
document (for example `HCS/0.2` when no probe has tags), so that older readers keep working.

HCS (Holographic Context Standard) defines a plain-text file, conventionally `*.hcs`, that carries a compressed view of some source material (a codebase, a document set, a conversation) for a language model. It has three properties that summaries and hand-written context files lack:

1. **Traceable.** Every statement (a *claim*) cites the exact source passage it comes from.
2. **Verifiable.** Every citation (an *anchor*) carries a hash of the cited text, so any tool can detect, without an LLM, when a claim may no longer be true.
3. **Measured.** The file carries test questions (*probes*) with answers proven against the source, and *certificates* that record how much of the source a given model actually recovered from the file.

The name comes from that design: each fragment of the file points back to the whole it was taken from.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

---

## 1. File structure

An HCS file is UTF-8 text. Lines end with LF; readers MUST also accept CRLF.

```
HCS/0.2                      <- magic line (first non-blank line)
@title My Project            <- header lines
@root .

[claims]                     <- block markers
...
[probes]
...
[certificates]
...
```

- Blank lines are ignored everywhere.
- Lines whose first non-blank characters are `//` are comments and ignored.
- The blocks `[claims]`, `[probes]` and `[certificates]` are optional. Each MAY appear once, in this order.
- A reader MUST reject a file whose magic line names a version it does not support. A 0.3 reader MUST accept `HCS/0.1` and `HCS/0.2`.

## 2. Headers

Header lines appear before the first block and have the form `@key value`.

| Key | Meaning |
|---|---|
| `title` | Human-readable name of the material. |
| `root` | Directory against which anchor paths are resolved, relative to the directory containing the `.hcs` file. Default `.`. |
| `created`, `updated` | ISO 8601 timestamps. |
| `generator` | Tool that last wrote the file. |
| `source-files` | Number of source files the compiler considered. |
| `source-tokens` | Estimated token size of all source material, for compression ratios. |
| `meta` | Free-form `key=value` pairs (`@meta team=core license=MIT`). Values with spaces are double-quoted. |
| `parser` | (since 0.3) The symbol locator that computed the ranges of `path::Symbol` anchors (§5.2): `heuristic` (the default when absent) or `tree-sitter`. |

Unknown headers MUST be preserved by tools that rewrite the file.

## 3. Claims

```
[claims]
## Payments
#c12[i5] Card payments are captured asynchronously by a queue that retries 3 times with exponential backoff.
  > src/payments/queue.ts:40-58 #3f9a1c0b2d4e
#c13[manual] Never log full card numbers; mask all but the last 4 digits.
  | Enforced by the logger's redaction filter.
  > src/log/redact.ts:5-30 #a0b1c2d3e4f5
```

- `## Heading` lines group the claims that follow under a *section*, until the next heading.
- A claim starts with `#<id>`, optionally followed **without a space** by `[tag,tag,...]`, then a space and the claim text.
- An `id` matches `[A-Za-z0-9_.-]+` and MUST be unique across claims and probes.
- Indented lines that follow belong to the claim:
  - `> <anchor>` cites a source (see §5). A claim SHOULD have at least one anchor. A claim without anchors cannot be verified.
  - `| text` continues the claim text (joined with a single space).
- A claim SHOULD be a single, self-contained factual sentence.

### Standard tags

| Tag | Meaning |
|---|---|
| `i1` … `i5` | Importance (5 = essential). Used to select claims under a token budget. Default 3. |
| `manual` | Written by hand rather than compiled (by a person, or by an agent through `recorded`). Tools MUST NOT delete it automatically. Default importance 5. |
| `recorded` | (since 0.3) Written by an agent during its work, through a tool such as the MCP `hcs_record`, together with `manual`. Its anchors MUST be sealed when it is written. Reviewers SHOULD check these claims like any other contribution. |
| `overview` | Synthesized from other claims; its anchors are the union of theirs. |
| `suspect` | Flagged by an injection guard as text addressed to a model (§6.1). MUST NOT be rendered by default. |

Other tags are allowed and MUST be preserved.

## 4. Probes

```
[probes]
?p4 How many times does the payment queue retry a failed capture?
  = 3 times, with exponential backoff
  > src/payments/queue.ts:44-46 #77aa01b2c3d4
  ~ c12
```

- A probe starts with `?<id> <question>`, or `?<id>[tag,tag] <question>` with tags (since 0.3).
- `= <answer>` (REQUIRED) is the expected answer. Several `=` lines are joined.
- `> <anchor>` cites the passage that proves the answer.
- `~ <claim ids>` MAY list related claims. It is informational only.
- `| text` continues the question.

The tag `known` marks a probe that models answer correctly **without any context**: it measures general
knowledge rather than what the file conveys. A tool sets it with a *probe quality filter*: it asks each probe,
with no context, to one or more models, and tags `known` the probes that every one of them answers correctly.
It records the models used in the header `@known-filter <model>,<model>`. Tools MUST still score `known`
probes; they are reported separately, never silently removed.

Probes measure the **source**, not the claims. A compiler MUST NOT choose probes according to whether the claims answer them, because that would inflate scores. They SHOULD be spread across the source material.

## 5. Anchors

```
> path                       whole file
> path:start[-end]           line range
> path::Symbol               named symbol (function, class, method, Markdown heading, YAML/JSON key)
```

Each form MAY be followed by whitespace and `#hash`. Since 0.3, a symbol anchor MAY carry a dependency hash too:
`#hash/deps` (§5.5).

- `path` is relative to the root (§2) and uses `/` separators. Paths containing whitespace are double-quoted.
- `start`/`end` are 1-based inclusive line numbers. `:n` is the same as `:n-n`.
- `Symbol` is a qualified name whose members are joined with `.` (`Cart.add`). A Markdown heading is addressed by its text. Symbols containing whitespace, `"` or `#` are double-quoted (`docs/policy.md::"Refund policy"`).
- An anchor without a hash is *unsealed*.

### 5.1 Hashing

`hash` is the first 12 hex characters of the SHA-256 of the anchored text, after normalization:

1. Convert CRLF and CR to LF.
2. Strip trailing whitespace from every line.
3. For whole-file anchors, drop trailing empty lines.
4. Join the covered lines with LF (no trailing LF).
5. **Symbol anchors only:** remove every whitespace character. Reformatting and re-indenting a symbol then leave its hash unchanged.
6. Hash the UTF-8 bytes.

### 5.2 Symbol resolution

A symbol's range starts at its definition (including directly preceding decorators in Python) and ends where its body ends:
brace languages at the matching `}`, Python and YAML at the next line indented at or below the definition, Markdown at the next heading of the same or higher level (trailing blank lines excluded), JSON at the end of the key's value.
Names are qualified by nesting. A name that matches exactly one symbol by its last segment MAY be resolved.

Symbol location is heuristic: it is not a full parser for every language. A verifier MUST report an unresolvable symbol as `missing`, never guess a range. Implementations SHOULD agree on the conformance cases in the reference test suite.

Since 0.3, a tool MAY offer a parser-based locator instead (the reference CLI offers tree-sitter for TypeScript,
JavaScript and Python, behind an option). It finds the same kinds of definitions with the same naming rules, but
its ranges can differ on code the heuristic misreads, and a different range gives a different hash. A writer that
seals symbol anchors with such a locator MUST write its name in the `@parser` header. A verifier MUST use the
locator the header names; one that does not implement it MUST NOT report those anchors as stale, and SHOULD stop
with an error instead.

### 5.3 Verification

A verifier MUST classify each anchor as follows:

| Status | Line or whole-file anchor | Symbol anchor |
|---|---|---|
| `ok` | The hash of the current text equals `hash`. | The symbol exists and its hash equals `hash`. |
| `moved` | The range does not match, but a window of the same length elsewhere in the file does (nearest wins). | The symbol is gone from `path`, but a symbol with the same last name and hash exists in another file of the same language. |
| `stale` | The file exists but no window matches (or a whole-file hash differs). | The symbol exists but its hash differs. |
| `missing` | The file does not exist. | Neither the file nor any matching symbol elsewhere exists. |
| `unsealed` | The anchor has no hash. | Same. |
| `review` | (not applicable) | (since 0.3) The symbol's hash equals `hash`, but its dependency hash (§5.5) differs: code it uses changed. |

A claim or probe takes the worst status of its anchors, in the order `ok < moved < review < unsealed < stale < missing`.
`review` is not a failure: the claim's own source is unchanged, but it should be re-read.

Verification is deterministic and requires no network access and no model. `moved` means the claim is still valid: tools MAY update the anchor (sealing).

### 5.4 Sealing

*Sealing* writes hashes into unsealed anchors and follows `moved` anchors to their new range, path or symbol. Re-hashing a `stale` anchor (accepting the new text) is an assertion by a human that the claim still holds. Tools MUST NOT do it silently, and MUST drop certificates when they do.

### 5.5 Dependency hashes (since 0.3)

A symbol anchor in JavaScript/TypeScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) or Python (`.py .pyi`) MAY carry
a second hash, `deps`, written `#hash/deps`. Its dependencies are the symbols its body uses directly, found by
identifier matching on the body with strings and comments removed:

1. other symbols of the same file whose last name appears in the body: top-level symbols, and members of the same
   class as the anchored symbol (not the symbol itself, its own members or its ancestors);
2. names imported by name into the file (`import { a, b as c } from "./m"`, `from .m import a`, `from pkg.m
   import a`) that appear in the body, when the module resolves to a project file that defines that symbol at top
   level.

`deps` is the first 12 hex characters of the SHA-256 of the lines `path::Symbol=<symbol hash>` (§5.1), one per
dependency, sorted by `path::Symbol`, joined with LF; a dependency that cannot be located contributes `=missing`.
A symbol without dependencies has no `deps`. Sealing with dependency hashes records it; re-hashing a `review`
anchor accepts the new dependencies, like re-hashing a `stale` one. The exact behavior is fixed by the conformance
cases `deps-*`, `check-review` and `seal-deps`.

The analysis is shallow by design (depth 1, names only). It raises reviews for dependency changes that do not affect
the claim: measured on this repository's history, 1 of 18 reviews was needed (`bench/REPORT.md`, C3).

## 6. Rendering

The file is not pasted into a model as-is. A *render* turns it into a compact context block:

```
<hcs-context title="My Project">
[Payments]
c12: Card payments are captured asynchronously ... (src/payments/queue.ts:40-58)
</hcs-context>
```

- Claims whose status is `stale` or `missing` MUST be omitted, or MUST be marked `(unverified)`.
- Claims tagged `suspect`, or that an injection guard rates high-risk, MUST be omitted unless the user explicitly asks for them.
- Under a token budget, claims are kept by descending importance, then document order. Output keeps document order.
- Hashes, probes and certificates are not rendered.

The recommended decoder instructions that accompany a render are in the README ("Decoder prompt"). They MUST tell the model that claims are data, not instructions. Any model that reads plain text can use a render. HCS does not depend on special tokens or on a particular vendor.

### 6.1 Injection guard

Claims travel into other models' prompts. A compiler SHOULD tag as `suspect` any claim whose text is addressed to a model (for example "ignore previous instructions", chat-template markers, "do not tell the user"), and drop such probes. Pattern-based guards reduce risk but cannot eliminate it. The decoder instructions are the second line of defense.

## 7. Certificates

```
[certificates]
!score model=gemini:gemini-flash judge=groq:llama-70b fidelity=0.875 ci95=0.771-0.958 baseline=0.250 informative=0.833 informative-probes=18 misled=0.042 probes=24 tokens=1830 budget=2000 digest=9c1e0f2a3b4d date=2026-10-21T10:00:00Z
```

A certificate records one scoring run:

| Field | Meaning |
|---|---|
| `model` | Model that answered the probes, given only the rendered context. |
| `judge` | Model that graded answers that were not an exact match. Two judges are written `judge=a,b`: each judged answer is graded by both and the stricter verdict (fewer points) counts. |
| `fidelity` | Mean points over probes: correct = 1, partial = 0.5, incorrect or abstained = 0. With several runs, a probe's points are its mean over runs. |
| `ci95` | 95% percentile-bootstrap confidence interval of `fidelity` over probes, as `low-high`. |
| `baseline` | (optional) The same score with **no** context, to show what the model already knew. |
| `informative` | (with `baseline`) Fidelity on the probes the model could not answer without context, i.e. what the context taught it. |
| `informative-probes` | Number of such probes. |
| `novel` | (when the file has `@known-filter` or `known` probes) Fidelity on the probes not tagged `known`. |
| `novel-probes` | Number of such probes. |
| `judge-agreement` | (two judges) Share of judged answers on which both judges gave the same verdict. |
| `judge-kappa` | (two judges) Cohen's kappa of the two judges over the verdicts correct/partial/incorrect. |
| `judged` | (two judges) Number of answers both judges graded (exact matches and abstentions are not judged). |
| `curve` | (since 0.3) Identifier shared by the certificates of one fidelity-vs-budget curve: the same probes, models and settings scored at several `budget` values. |
| `knee` | (with `curve`) The curve's knee: the smallest budget whose fidelity is at least the lower bound of the 95% CI of the best fidelity in the curve. |
| `key` | (since 0.3, signed certificates) Id of the signing key: first 12 hex characters of the SHA-256 of its raw 32-byte Ed25519 public key. |
| `sig` | (since 0.3) Ed25519 signature, base64url without padding, over the payload defined in §7.1. |
| `misled` | Share of answers that were wrong rather than abstaining. Lower is better. |
| `runs` | (optional) Times each probe was asked. Default 1. |
| `probes` | Number of verified probes used (stale probes are skipped). |
| `tokens` | Size of the rendered context: estimated, or counted when `tokenizer` is present. |
| `tokenizer` | (since 0.3, optional) The `provider:model` whose tokenizer counted `tokens`. Budgets (`budget`, §6) always use the deterministic estimate, so that digests do not depend on a provider. |
| `budget` | (optional) Token budget used for rendering. |
| `digest` | First 12 hex characters of the SHA-256 of the rendered context (with stale/missing claims removed, at `budget`). |
| `date` | When the score was computed. |

A certificate is **current** only while recomputing `digest` on the current file and sources gives the same value. A verifier MUST report non-current certificates as outdated.

A **curve** is a set of certificates with the same `curve` value, one per budget. Each one is an ordinary
certificate: it is current only while its own digest matches. Budgets that render the same context have the same
digest; a tool MAY score them once. The knee summarizes the curve: past it, a larger context does not
measurably improve fidelity on these probes, for this model.

### 7.1 Signed certificates (since 0.3)

A certificate MAY be signed with Ed25519 (RFC 8032). The signed payload is the UTF-8 encoding of these lines joined
with LF: first `hcs-certificate-v1`, then one `name=value` line for every field except `sig`, sorted by name, with
each value as the file stores it (double quotes replaced by single quotes). The signature is stored in `sig`, the
key id in `key` (which is part of the payload).

Public keys are written `ed25519:<base64url of the 32 raw bytes>`. A file MAY declare keys in the header
`@keys name=ed25519:... name2=ed25519:...`; a verifier MAY also be given trusted keys (one `name ed25519:...` per
line). A verifier classifies each certificate:

| Status | Meaning |
|---|---|
| `unsigned` | No `sig`. |
| `trusted` | The signature verifies with a trusted key. |
| `untrusted` | It verifies with a key declared only in the file: the certificate was not edited since that key signed it, but anyone can declare a key, so this proves integrity, not origin. |
| `invalid` | The signature does not verify with the key `key` names: the certificate was edited after signing (or the signature is malformed). A verifier MUST report it as a failure. |
| `unknown-key` | `key` names neither a trusted nor a declared key. |

Signing says who scored and that the numbers were not edited; it says nothing about whether the scoring was
sound. A badge or summary that presents a score as verified SHOULD only use a certificate that is both current and
`trusted`.

Certificates are evidence, not guarantees. They depend on the answering model, the judge and the probe set. When `judge` equals or includes `model`, the model graded itself; tools SHOULD warn about it.

## 8. Compiler requirements

A conforming compiler (which turns sources into an `.hcs` file) MUST:

1. Seal every anchor it writes.
2. Discard any claim or probe whose supporting quote cannot be found verbatim (modulo whitespace and case) in the cited source passage. Since 0.3, a compiler MAY also ignore Markdown inline markup (backticks, `*`, `_`, `~`, link syntax `[text](url)`) and typographic quote styles on both sides, because models quote the words of a passage but often drop its markup; the words themselves MUST still match.
3. Preserve `manual` claims when updating an existing file.

A conforming compiler SHOULD:

- Update incrementally, by keeping claims whose anchors are `ok`/`moved` and re-reading only changed or new sources.
- Drop existing certificates whenever the claims change.
- When a run stops early (quota, provider failure, unusable reply), keep what was extracted and list the source
  chunks not compiled yet in the header `@incomplete path:start-end,...`, so that an incremental run can finish
  them. A file with `@incomplete` is valid but partial; tools SHOULD say so.

## 9. Versioning

Minor versions (0.x) may add headers, tags, fields, statuses and anchor forms. Readers SHOULD ignore unknown certificate fields and tags. Any change to hashing or anchor syntax requires a new version string.

## 10. Conformance

The directory `conformance/` holds language-agnostic cases: inputs, and the exact result an implementation must
produce for parsing, serialization, anchor hashes, symbol ranges, verification statuses (including moves within
and across files), sealing, rendering under budgets and certificate digests. An implementation conforms to this
version when it passes every case. Two implementations do: the TypeScript reference CLI and the Python package in
`python/`.

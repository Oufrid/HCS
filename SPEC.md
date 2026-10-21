# HCS Specification: version 0.1

**Status:** draft. Feedback is welcome through issues.

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
HCS/0.1                      <- magic line (first non-blank line)
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
- A reader MUST reject a file whose magic line has a different major/minor version than it supports.

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
| `manual` | Written by a human. Tools MUST NOT delete it automatically. Default importance 5. |
| `overview` | Synthesized from other claims; its anchors are the union of theirs. |

Other tags are allowed and MUST be preserved.

## 4. Probes

```
[probes]
?p4 How many times does the payment queue retry a failed capture?
  = 3 times, with exponential backoff
  > src/payments/queue.ts:44-46 #77aa01b2c3d4
  ~ c12
```

- A probe starts with `?<id> <question>`.
- `= <answer>` (REQUIRED) is the expected answer. Several `=` lines are joined.
- `> <anchor>` cites the passage that proves the answer.
- `~ <claim ids>` MAY list related claims. It is informational only.
- `| text` continues the question.

Probes measure the **source**, not the claims. A compiler MUST NOT choose probes according to whether the claims answer them, because that would inflate scores. They SHOULD be spread across the source material.

## 5. Anchors

```
> path[:start[-end]] [#hash]
```

- `path` is relative to the root (§2) and uses `/` separators. Paths containing whitespace are double-quoted.
- `start`/`end` are 1-based inclusive line numbers. Without them, the anchor covers the whole file. `:n` is the same as `:n-n`.
- `hash` is the first 12 hex characters of the SHA-256 of the **normalized** anchored text, computed as follows:
  1. Convert CRLF and CR to LF.
  2. Strip trailing whitespace from every line.
  3. For whole-file anchors, drop trailing empty lines.
  4. Join the covered lines with LF (no trailing LF) and hash the UTF-8 bytes.
- An anchor without a hash is *unsealed*.

### 5.1 Verification

A verifier MUST classify each anchor as follows:

| Status | Condition |
|---|---|
| `ok` | The hash of the current text at `path:start-end` equals `hash`. |
| `moved` | The range does not match, but a window of the same length elsewhere in the file does. The verifier SHOULD report the nearest such window. The claim is still valid; tools MAY update the line numbers (sealing). |
| `stale` | The file exists but no window matches (or a whole-file hash differs). The claim may be false. |
| `missing` | The file does not exist. |
| `unsealed` | The anchor has no hash. |

A claim or probe takes the worst status of its anchors, in the order `ok < moved < unsealed < stale < missing`.

Verification is deterministic and requires no network access and no model.

### 5.2 Sealing

*Sealing* writes hashes into unsealed anchors and follows `moved` anchors to their new range. Re-hashing a `stale` anchor (accepting the new text) is an assertion by a human that the claim still holds. Tools MUST NOT do it silently.

## 6. Rendering

The file is not pasted into a model as-is. A *render* turns it into a compact context block:

```
<hcs-context title="My Project">
[Payments]
c12: Card payments are captured asynchronously ... (src/payments/queue.ts:40-58)
</hcs-context>
```

- Claims whose status is `stale` or `missing` MUST be omitted, or MUST be marked `(unverified)`.
- Under a token budget, claims are kept by descending importance, then document order. Output keeps document order.
- Hashes, probes and certificates are not rendered.

The recommended decoder instructions that accompany a render are in the README ("Decoder prompt"). Any model that reads plain text can use a render. HCS does not depend on special tokens or on a particular vendor.

## 7. Certificates

```
[certificates]
!score model=openai:gpt-4o-mini judge=openai:gpt-4o-mini fidelity=0.875 baseline=0.250 misled=0.042 probes=24 tokens=1830 budget=2000 digest=9c1e0f2a3b4d date=2026-10-21T10:00:00Z
```

A certificate records one scoring run:

| Field | Meaning |
|---|---|
| `model` | Model that answered the probes, given only the rendered context. |
| `judge` | Model that graded answers that were not an exact match. |
| `fidelity` | Mean points over probes: correct = 1, partial = 0.5, incorrect or abstained = 0. |
| `baseline` | (optional) The same score with **no** context, to show what the model already knew. |
| `misled` | Share of probes answered wrongly rather than abstaining. Lower is better. |
| `probes` | Number of verified probes used (stale probes are skipped). |
| `tokens` | Estimated size of the rendered context. |
| `budget` | (optional) Token budget used for rendering. |
| `digest` | First 12 hex characters of the SHA-256 of the rendered context (with stale/missing claims removed, at `budget`). |
| `date` | When the score was computed. |

A certificate is **current** only while recomputing `digest` on the current file and sources gives the same value. A verifier MUST report non-current certificates as outdated.

Certificates are evidence, not guarantees. They depend on the answering model, the judge and the probe set.

## 8. Compiler requirements

A conforming compiler (which turns sources into an `.hcs` file) MUST:

1. Seal every anchor it writes.
2. Discard any claim or probe whose supporting quote cannot be found verbatim (modulo whitespace and case) in the cited source passage.
3. Preserve `manual` claims when updating an existing file.

A conforming compiler SHOULD:

- Update incrementally, by keeping claims whose anchors are `ok`/`moved` and re-reading only changed or new sources.
- Drop existing certificates whenever the claims change.

## 9. Versioning

Minor versions (0.x) may add headers, tags, fields and statuses. Readers SHOULD ignore unknown certificate fields and tags. Any change to hashing or anchor syntax requires a new version string.

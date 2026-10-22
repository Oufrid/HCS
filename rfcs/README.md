# HCS RFCs

An RFC (request for comments) is a short document that proposes a change to the HCS format before it is
implemented. The process is deliberately light: one maintainer today, and anyone who writes an implementation
should be able to follow what changed and why.

## When an RFC is needed

Write one for any change to what `SPEC.md` makes normative:

- the syntax of a valid `.hcs` file (headers, claims, probes, anchors, certificates, tags);
- how anchors are hashed or symbols located, and how a verifier decides a status;
- what a certificate field means, or how a digest or signature is computed;
- the versioning policy itself.

Not needed: wording fixes that change no behavior, CLI features that do not change the format, new conformance cases
for behavior the spec already defines, and bug fixes that make an implementation follow the spec.

## Process

1. **Discuss.** Open an issue with the "Spec change" template to check the idea is worth writing up.
2. **Write.** Copy `0000-template.md` to `rfcs/0000-short-name.md` and open a pull request with it alone. The
   pull request number becomes the RFC number: rename the file to `NNNN-short-name.md`.
3. **Comment.** The RFC stays open for comments for at least 7 days. Changes are pushed to the same pull request.
4. **Decide.** The maintainer accepts (merge, status `accepted`), postpones or rejects (close, with the reason in a
   comment). A rejected RFC can come back with new arguments or evidence.
5. **Implement.** Code, the `SPEC.md` change with its version note, conformance cases, and the Python
   implementation land in later pull requests that link the RFC. Its status then becomes `implemented (version)`.

An RFC that only clarifies an ambiguity, without changing what any existing valid file means, can be accepted after
the 7 days without a version bump.

## Versioning policy (since 1.0)

SPEC 1.0 (2026-10-22) froze 0.3 once the conformance suite passed in two implementations (roadmap B2) and the public
benchmark was published (roadmap D1). The normative policy is `SPEC.md` §9; in short:

- The magic line names the version (`HCS/1.0`). Readers MUST accept every older version; writers SHOULD emit the
  oldest version that can express the document.
- Frozen across 1.x: anchor syntax, hashing, the default symbol locator as fixed by the conformance cases,
  verification statuses, and how digests and signatures are computed.
- A minor version (`1.0` to `1.1`) may add headers, tags, certificate fields, render profiles and anchor forms. It
  must not change the meaning, hash, status or digest of anything an older file already contains.
- A change that would break existing files needs a major version (2.0) and a migration path.

## Index

| RFC | Title | Status |
|---|---|---|
| (none accepted) | Changes up to 0.3 predate this process; they are listed at the top of `SPEC.md`. | |
| [0000](0000-deps-ignore-types-and-keys.md) | Ignore type-only and key-only names in dependency hashes | postponed |

# Security

HCS moves text from source files into other models' prompts, and its MCP server reads files on behalf of AI
agents. This document says what it defends against, what it does not, and how to report a problem.

## Reporting a vulnerability

Please report privately with GitHub's **Report a vulnerability** button (Security tab of the repository), not in a
public issue. Include the HCS version (`hcs --version`), the command, and a minimal `.hcs` file or source that
reproduces it. Expect a first answer within a week. Fixes come with a regression test and a note in the
changelog; credit is given unless you ask otherwise.

## Threat model

### 1. A malicious source file

Someone controls a file that gets compiled (a dependency's README, a pasted conversation, a contributed doc).

| Risk | Defense | Limit |
|---|---|---|
| Text aimed at the compiling model ("ignore previous instructions...") | The compile prompt says sources are data; `compile` and `snapshot` scan every source line and list injection-like lines (`src/guard.ts::scanSource`). | Pattern-based. |
| Such text copied into a claim, then into every model that reads the context | High-risk claims are tagged `suspect` and never rendered by default; such probes are dropped; `check --strict` fails on suspect claims; the decoder prompt says claims are never instructions. | On a held-out set the patterns caught 7 of 15 novel attacks (README, Security). Treat the guard as a filter, not a guarantee. |
| A model inventing facts or citations | Every compiled claim and probe must quote the cited passage verbatim, or it is discarded. | A verbatim quote proves the text exists, not that the claim's paraphrase is faithful. |

### 2. A malicious `.hcs` file

Someone controls the `.hcs` file itself (a cloned repository, a pull request).

| Risk | Defense | Limit |
|---|---|---|
| Crashing or hanging the parser | Parse errors are `HcsSyntaxError` with a line number; fuzz tests (`test/fuzz.test.ts`) feed thousands of mutated and random files. The parser is line-based with bounded regexes. | Fuzzing is randomized, not exhaustive. |
| Anchors that point outside the project (`> ../../.ssh/id_rsa`, absolute paths, symlinks) to make tools or the MCP server read private files | All source reads go through the project root sandbox (`src/anchors.ts::insideRoot`): such anchors are reported `missing` and never read. | The root itself comes from `@root`, see next row. |
| An `@root` header that widens the sandbox (`@root /`) | `hcs serve` refuses a root outside the working directory unless `--root` is passed explicitly. | `check`, `render` and `score` honor `@root`; they only print hashes and statuses, never source text. |
| Hand-written claims that carry instructions | Same guard as compiled claims: high-risk text is not rendered and fails `check --strict`. | Same pattern limit. |
| Fake certificates (made-up fidelity scores) | A certificate is bound to a digest of the rendered context; `check` reports it outdated when the context changes. Certificates can be signed with Ed25519: `check --trusted keys.txt` names the signer and fails when a signed certificate was edited; `badge` only uses current certificates signed by a trusted key. | Unsigned certificates can still be written by anyone, and a key declared in the file itself only proves integrity, not origin. A signature proves who scored, not that the scoring was sound. Keep signing keys out of the repository (a CI secret). |

### 3. A malicious MCP client

An agent connected to `hcs serve` tries to read or change more than it should.

| Risk | Defense | Limit |
|---|---|---|
| Reading files outside the project | `hcs_source` and `hcs_expand` read only through the root sandbox, symlinks included. | Everything under the root is readable, including files ignored by git. Do not serve from a directory holding secrets. |
| Writing files or running commands | All tools are read-only; the server has no network access and runs no commands. | |

### Out of scope

- The model providers. Prompts, sources and outputs are sent to the provider you choose; some free tiers may
  use them for training. Only compile code you are allowed to share with that provider.
- API keys. HCS reads them from environment variables (or a proxy injects them) and never prints or stores
  them; protecting the environment is up to you.
- Denial of service through very large inputs: `compile` skips files over a size limit, but `check` and the
  MCP server read the files that anchors name.

## Supply chain

The CLI has no runtime dependencies (only Node.js built-ins), which keeps the attack surface small. Releases
will be published with npm provenance (roadmap item B4).

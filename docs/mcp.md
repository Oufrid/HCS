# Using HCS from an MCP client

`hcs serve <file.hcs>` is a Model Context Protocol server (stdio, JSON-RPC 2.0, no dependencies). It gives an agent
the compact, verified context first, and the exact cited source on demand.

| Kind | Name | What it returns |
|---|---|---|
| tool | `hcs_context` | The rendered context (stale claims excluded), optionally within a token `budget`. |
| tool | `hcs_expand` | One claim or probe with its status and the source text of each anchor. |
| tool | `hcs_search` | Claims matching keywords, with their sources. |
| tool | `hcs_verify` | Statuses (ok, moved, stale, missing, unsealed), for given ids or all. |
| tool | `hcs_source` | A source file under the project root, or a line range, or a named symbol. |
| tool | `hcs_record` | Only with `--allow-write`: adds a claim to the file, see below. |
| resource | `hcs://context` | Same text as `hcs_context`. |
| resource | `hcs://claim/<id>` | Same text as `hcs_expand` for that claim (also listed as a resource template). |

The server reads the `.hcs` file again on every request, so `hcs compile --update` or `hcs seal` while it runs is
picked up without a restart.

## Safety

- Every source read stays inside the project root, symlinks included. The root is the file's `@root` header,
  and `hcs serve` refuses an `@root` outside the working directory unless `--root` is given. See
  [SECURITY.md](../SECURITY.md).
- Without `--allow-write` the server is read-only. With it, `hcs_record` can only append claims: it validates
  the text (one sentence, at most 400 characters, refused if it looks like an instruction to a model) and every
  anchor (inside the root, existing file, existing symbol, valid line range), then hashes the anchors and writes
  the file atomically.

## `hcs_record`: keep what an agent verified

An agent that reads the code during a task learns facts the context does not state. `hcs_record` lets it write
them down with proof:

```json
{ "text": "Parcels over 30 kg are refused.", "anchors": ["src/rates.ts::shippingFee"], "section": "Rates" }
```

The claim gets an id `r1`, `r2`... and the tags `manual` (incremental compiles never drop it) and `recorded`
(written by an agent through MCP; review these in pull requests). Its anchors are sealed, so `hcs check` flags it
as soon as `shippingFee` changes.

## Client setup

Install the CLI once with `npm install -g @oufrid/hcs-cli`, which puts `hcs` on your PATH; the configurations below
assume it. To run a clone instead, replace `"command": "hcs"` with `"command": "node"` and put the path to the built
CLI first in `args`, e.g. `["/path/to/HCS/dist/src/cli.js", "serve", "project.hcs"]`. Add `"--allow-write"` to
`args` to enable `hcs_record`.

**Claude Code** (verified, see below). In the project directory:

```bash
claude mcp add hcs -- hcs serve project.hcs                    # just for you
claude mcp add --scope project hcs -- hcs serve project.hcs    # writes .mcp.json for the team
```

or commit [examples/mcp/claude-code.mcp.json](../examples/mcp/claude-code.mcp.json) as `.mcp.json` at the
project root. Claude Code asks once before it starts a server from a project `.mcp.json`. It starts servers in the
project directory, so relative paths work. MCP resources are available through its resource tools
(`ReadMcpResourceTool`).

**Claude Desktop** (not tested yet). Add [examples/mcp/claude-desktop.json](../examples/mcp/claude-desktop.json) to
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and
restart the app. Use absolute paths and `--root`: the app does not start the server in your project directory.

**Cursor** (not tested yet). Put [examples/mcp/cursor.mcp.json](../examples/mcp/cursor.mcp.json) in
`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (all projects). Absolute paths with `--root` are the safe
choice.

**VS Code** (not tested yet). Put [examples/mcp/vscode.mcp.json](../examples/mcp/vscode.mcp.json) in
`.vscode/mcp.json`. VS Code uses a `servers` key and expands `${workspaceFolder}`.

## Verified session

On 2026-10-21, Claude Code 2.1.306 connected to `hcs serve --allow-write` and, in one non-interactive session,
called `hcs_context`, `hcs_search`, `hcs_expand`, read the resource `hcs://claim/resume`, read a symbol with
`hcs_source`, recorded a claim with `hcs_record`, and verified it with `hcs_verify` (status `ok`). The transcript is
in [mcp-session-2026-10-21.md](mcp-session-2026-10-21.md). To reproduce it, see the command at the top of that file.

For a quick connection check without a model call, run `claude mcp list` in the project: after
`claude mcp add hcs -- hcs serve project.hcs` it printed `hcs: ... - √ Connected`. A server from a project
`.mcp.json` shows `Pending approval` until you approve it in an interactive `claude` session.

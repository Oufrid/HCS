// `hcs serve`: a Model Context Protocol server (stdio, JSON-RPC 2.0) over one .hcs file.
// It lets any MCP client read the compact context first, then zoom into the exact cited source on demand.

import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { checkDocument, insideRoot, rootDir, SourceCache, type AnchorStatus } from "./anchors.js";

export { insideRoot };
import { formatAnchor, parse, type Claim, type HcsDocument } from "./format.js";
import { DECODER_PROMPT, renderContext } from "./render.js";
import { findSymbol } from "./symbols.js";

export const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const TOOLS = [
  {
    name: "hcs_context",
    description:
      "Get the verified HCS context for this project: short claims, each citing its source. Read this first. Stale claims are excluded.",
    inputSchema: {
      type: "object",
      properties: { budget: { type: "number", description: "Optional token budget; the most important claims are kept." } },
    },
  },
  {
    name: "hcs_expand",
    description:
      "Show the exact source text behind a claim or probe id (e.g. c12), with line numbers and verification status. Use it before relying on a detail the claim does not state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Claim or probe id" },
        max_lines: { type: "number", description: "Maximum lines per anchor (default 120)" },
      },
      required: ["id"],
    },
  },
  {
    name: "hcs_search",
    description: "Search claims by keywords and return the best matches with their sources.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number", description: "Default 10" } },
      required: ["query"],
    },
  },
  {
    name: "hcs_verify",
    description: "Check whether claims still match their sources (ok, moved, stale, missing, unsealed). Without ids, summarizes all.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "hcs_source",
    description: "Read a source file under the project root, optionally a line range or a named symbol (function, class, heading).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        symbol: { type: "string" },
      },
      required: ["path"],
    },
  },
];

export class HcsMcpServer {
  /** `root` overrides the file's `@root` header; it is the sandbox for every source read. */
  constructor(private file: string, private root?: string) {}

  private load(): { doc: HcsDocument; cache: SourceCache } {
    if (!existsSync(this.file)) throw new Error(`HCS file not found: ${this.file}`);
    const doc = parse(readFileSync(this.file, "utf8"));
    return { doc, cache: new SourceCache(this.root ?? rootDir(doc, this.file)) };
  }

  /** Returns the response to send, or null for notifications. */
  async handle(msg: JsonRpcRequest): Promise<object | null> {
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this.dispatch(msg);
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: msg.id, result };
    } catch (e) {
      if (isNotification) return null;
      const code = (e as { code?: number }).code ?? -32603;
      return { jsonrpc: "2.0", id: msg.id, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
  }

  private async dispatch(msg: JsonRpcRequest): Promise<unknown> {
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "hcs", version: SERVER_VERSION },
          instructions: DECODER_PROMPT + "\n\nCall hcs_context first; call hcs_expand on a claim id before relying on details it does not state.",
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return {};
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return this.callTool(msg.params?.name, msg.params?.arguments ?? {});
      default:
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  }

  private callTool(name: string, args: Record<string, unknown>): ToolResult {
    try {
      const text = this.runTool(name, args);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  }

  private runTool(name: string, args: Record<string, unknown>): string {
    const { doc, cache } = this.load();
    const reports = checkDocument(doc, cache);
    const status = new Map(reports.map((r) => [r.id, r.status]));
    const claimStatus = new Map(reports.filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));

    switch (name) {
      case "hcs_context": {
        const budget = typeof args.budget === "number" && args.budget > 0 ? args.budget : undefined;
        const stale = [...claimStatus.values()].filter((s) => s === "stale" || s === "missing").length;
        const note = stale ? `\n(${stale} stale claim(s) were excluded; their sources changed.)` : "";
        return renderContext(doc, { status: claimStatus, budget }) + note;
      }

      case "hcs_expand": {
        const id = String(args.id ?? "");
        const item = doc.claims.find((c) => c.id === id) ?? doc.probes.find((p) => p.id === id);
        if (!item) throw new Error(`no claim or probe "${id}"`);
        const maxLines = typeof args.max_lines === "number" && args.max_lines > 0 ? Math.floor(args.max_lines) : 120;
        const report = reports.find((r) => r.id === id)!;
        const head = "text" in item ? `${id}: ${item.text}` : `${id}: ${item.question}`;
        const parts = [`${head}\nstatus: ${status.get(id)}`];
        report.anchors.forEach((ar) => {
          parts.push(`\n--- ${formatAnchor(ar.anchor, false)} [${ar.status}${ar.detail ? `: ${ar.detail}` : ""}]`);
          parts.push(excerpt(cache, ar.anchor.path, rangeOf(cache, ar.anchor, ar.relocated), maxLines));
        });
        return parts.join("\n");
      }

      case "hcs_search": {
        const q = String(args.query ?? "").toLowerCase();
        const terms = q.split(/\W+/).filter((t) => t.length > 1);
        if (!terms.length) throw new Error("empty query");
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 10;
        const scored = doc.claims
          .map((c) => ({ c, score: scoreClaim(c, terms) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (!scored.length) return "no matching claims";
        return scored
          .map(({ c }) => `${c.id} [${claimStatus.get(c.id)}]: ${c.text} (${c.anchors.map((a) => formatAnchor(a, false)).join("; ")})`)
          .join("\n");
      }

      case "hcs_verify": {
        const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
        const selected = ids ? reports.filter((r) => ids.includes(r.id)) : reports;
        if (ids) {
          const unknown = ids.filter((i) => !reports.some((r) => r.id === i));
          if (unknown.length) throw new Error(`unknown ids: ${unknown.join(", ")}`);
        }
        const counts = new Map<AnchorStatus, number>();
        for (const r of selected) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        const lines = [`${selected.length} item(s): ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}`];
        for (const r of selected.filter((r) => ids || r.status !== "ok")) {
          lines.push(`${r.id}: ${r.status}${r.anchors.filter((a) => a.detail).map((a) => ` (${formatAnchor(a.anchor, false)}: ${a.detail})`).join("")}`);
        }
        return lines.join("\n");
      }

      case "hcs_source": {
        const path = String(args.path ?? "");
        const rel = insideRoot(cache.root, path);
        const lines = cache.lines(rel.split(sep).join("/"));
        if (!lines) throw new Error(`file not found: ${path}`);
        let range: { start: number; end: number } = { start: 1, end: lines.length };
        if (typeof args.symbol === "string") {
          const s = findSymbol(path, lines, args.symbol);
          if (!s) throw new Error(`symbol "${args.symbol}" not found in ${path}`);
          range = s;
        } else if (typeof args.start === "number") {
          range = { start: Math.max(1, Math.floor(args.start)), end: Math.min(lines.length, Math.floor(typeof args.end === "number" ? args.end : args.start + 199)) };
        }
        return excerpt(cache, rel.split(sep).join("/"), range, 400);
      }

      default:
        throw new Error(`unknown tool "${name}"`);
    }
  }
}

function rangeOf(
  cache: SourceCache,
  a: { path: string; symbol?: string; start?: number; end?: number },
  relocated?: { path?: string; symbol?: string; start?: number; end?: number },
): { start: number; end: number; path?: string } | null {
  if (relocated?.path) {
    const s = cache.symbol(relocated.path, relocated.symbol ?? a.symbol ?? "");
    return s ? { ...s, path: relocated.path } : null;
  }
  if (relocated?.start !== undefined) return { start: relocated.start, end: relocated.end ?? relocated.start };
  if (a.symbol !== undefined) return cache.symbol(a.path, a.symbol);
  const lines = cache.lines(a.path);
  if (!lines) return null;
  if (a.start === undefined) return { start: 1, end: lines.length };
  return { start: a.start, end: Math.min(a.end ?? a.start, lines.length) };
}

function excerpt(cache: SourceCache, path: string, range: { start: number; end: number; path?: string } | null, maxLines: number): string {
  const file = range?.path ?? path;
  const lines = cache.lines(file);
  if (!lines || !range) return "(source not available)";
  const end = Math.min(range.end, range.start + maxLines - 1);
  const width = String(end).length;
  const body = lines.slice(range.start - 1, end).map((l, i) => `${String(range.start + i).padStart(width)}| ${l}`);
  if (end < range.end) body.push(`... (${range.end - end} more lines; use hcs_source with start/end)`);
  return `${file}:${range.start}-${range.end}\n${body.join("\n")}`;
}

function scoreClaim(c: Claim, terms: string[]): number {
  const hay = `${c.text} ${c.section ?? ""} ${c.anchors.map((a) => `${a.path} ${a.symbol ?? ""}`).join(" ")}`.toLowerCase();
  // Match word starts, so "rate" finds "rates" and "rate-limit" but not "regenerates".
  const words = hay.split(/[^a-z0-9_]+/).filter(Boolean);
  return terms.reduce((n, t) => n + (words.some((w) => w.startsWith(t)) ? 1 : 0), 0);
}

/** Run the server on stdio until stdin closes. Logs go to stderr; stdout carries only protocol messages. */
export async function serveStdio(file: string, root?: string): Promise<void> {
  const server = new HcsMcpServer(resolve(file), root && resolve(root));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stderr.write(`hcs MCP server ready for ${file}\n`);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      continue;
    }
    const res = await server.handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  }
}

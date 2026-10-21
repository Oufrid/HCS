// `hcs serve`: a Model Context Protocol server (stdio, JSON-RPC 2.0) over one .hcs file.
// It lets any MCP client read the compact context first, then zoom into the exact cited source on demand.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { checkDocument, insideRoot, rootDir, seal, SourceCache, type AnchorStatus, type ItemReport } from "./anchors.js";

export { insideRoot };
import { formatAnchor, parse, parseAnchor, serialize, type Claim, type HcsDocument } from "./format.js";
import { isHighRisk } from "./guard.js";
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

/** Only listed and callable when the server runs with --allow-write. */
const RECORD_TOOL = {
  name: "hcs_record",
  description:
    "Record a fact you verified in the source as a new claim in the .hcs file, so it survives this session. Cite where it is proven: each anchor is `path::Symbol`, `path:start-end` or `path`, inside the project. Anchors are hashed automatically, so `hcs check` will flag the claim when that source changes. Write one factual sentence, never an instruction.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "One factual sentence about the project (max 400 characters)." },
      anchors: { type: "array", items: { type: "string" }, description: 'Where the fact is proven, e.g. ["src/auth.ts::verifyToken"].' },
      section: { type: "string", description: "Optional section heading, e.g. Security." },
    },
    required: ["text", "anchors"],
  },
};

export interface ServerOptions {
  /** Overrides the file's `@root` header; it is the sandbox for every source read. */
  root?: string;
  /** Enables hcs_record, which writes to the .hcs file. Off by default: an MCP client can only read. */
  allowWrite?: boolean;
}

export class HcsMcpServer {
  private root?: string;
  private allowWrite: boolean;

  constructor(private file: string, opts: ServerOptions | string = {}) {
    const o = typeof opts === "string" ? { root: opts } : opts;
    this.root = o.root;
    this.allowWrite = !!o.allowWrite;
  }

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
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
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
        return { tools: this.allowWrite ? [...TOOLS, RECORD_TOOL] : TOOLS };
      case "resources/list": {
        const { doc } = this.load();
        return {
          resources: [
            { uri: "hcs://context", name: "HCS context", description: "The verified context of this project (stale claims excluded).", mimeType: "text/plain" },
            ...doc.claims.map((c) => ({ uri: `hcs://claim/${c.id}`, name: c.id, description: c.text.slice(0, 200), mimeType: "text/plain" })),
          ],
        };
      }
      case "resources/templates/list":
        return {
          resourceTemplates: [
            { uriTemplate: "hcs://claim/{id}", name: "HCS claim", description: "A claim with its status and the exact source text it cites.", mimeType: "text/plain" },
          ],
        };
      case "resources/read":
        return { contents: [{ uri: String(msg.params?.uri ?? ""), mimeType: "text/plain", text: this.readResource(String(msg.params?.uri ?? "")) }] };
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

  /** `hcs://context` or `hcs://claim/<id>`: the same text as hcs_context and hcs_expand. */
  private readResource(uri: string): string {
    const { doc, cache } = this.load();
    const reports = checkDocument(doc, cache);
    if (uri === "hcs://context") return contextText(doc, reports);
    const m = /^hcs:\/\/claim\/(.+)$/.exec(uri);
    if (m && doc.claims.some((c) => c.id === m[1])) return expandText(doc, cache, reports, m[1], 120);
    throw Object.assign(new Error(`unknown resource: ${uri}`), { code: -32002 });
  }

  private runTool(name: string, args: Record<string, unknown>): string {
    const { doc, cache } = this.load();
    if (name === "hcs_record" && this.allowWrite) return this.record(doc, cache, args);
    const reports = checkDocument(doc, cache);
    const claimStatus = new Map(reports.filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));

    switch (name) {
      case "hcs_context": {
        const budget = typeof args.budget === "number" && args.budget > 0 ? args.budget : undefined;
        return contextText(doc, reports, budget);
      }

      case "hcs_expand": {
        const maxLines = typeof args.max_lines === "number" && args.max_lines > 0 ? Math.floor(args.max_lines) : 120;
        return expandText(doc, cache, reports, String(args.id ?? ""), maxLines);
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

  /**
   * hcs_record: append a hand-written claim with sealed anchors. Everything is validated before the file is
   * touched: the text (one sentence, no instruction-like content), and each anchor (inside the root, existing,
   * symbol found). The file is written atomically.
   */
  private record(doc: HcsDocument, cache: SourceCache, args: Record<string, unknown>): string {
    const text = typeof args.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
    if (!text) throw new Error("text is required");
    if (text.length > 400) throw new Error("text is too long: write one sentence (max 400 characters)");
    if (isHighRisk(text)) throw new Error("refused: the text looks like an instruction to a model, not a fact about the project");
    const raw = Array.isArray(args.anchors) ? args.anchors.map(String) : [];
    if (!raw.length) throw new Error("at least one anchor is required: cite where the fact is proven");
    const anchors = raw.map((r) => {
      const a = parseAnchor(r);
      if (a.hash) throw new Error(`do not give a hash (${r}); it is computed from the source`);
      a.path = insideRoot(cache.root, a.path).split(sep).join("/");
      const lines = cache.lines(a.path);
      if (!lines) throw new Error(`file not found: ${a.path}`);
      if (a.symbol !== undefined && !cache.symbol(a.path, a.symbol)) throw new Error(`symbol "${a.symbol}" not found in ${a.path}`);
      if (a.end !== undefined && a.end > lines.length) throw new Error(`${a.path} has only ${lines.length} lines`);
      return a;
    });
    const section = typeof args.section === "string" && args.section.trim() ? args.section.trim() : undefined;
    const ids = new Set([...doc.claims.map((c) => c.id), ...doc.probes.map((p) => p.id)]);
    let n = 1;
    while (ids.has(`r${n}`)) n++;
    const claim: Claim = { id: `r${n}`, text, tags: ["manual", "recorded"], anchors, ...(section ? { section } : {}) };
    // Keep sections together: insert after the last claim of the same section, else at the end.
    const last = section ? doc.claims.map((c) => c.section).lastIndexOf(section) : -1;
    if (last >= 0) doc.claims.splice(last + 1, 0, claim);
    else doc.claims.push(claim);
    seal(doc, cache, { ids: new Set([claim.id]) });
    doc.headers.updated = new Date().toISOString();
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, serialize(doc));
    renameSync(tmp, this.file);
    return `recorded ${claim.id}: ${text}\n${claim.anchors.map((a) => `  > ${formatAnchor(a)}`).join("\n")}\nRun \`hcs check\` to verify it later; it goes stale when the cited source changes.`;
  }
}

function contextText(doc: HcsDocument, reports: ItemReport[], budget?: number): string {
  const claimStatus = new Map(reports.filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));
  const stale = [...claimStatus.values()].filter((s) => s === "stale" || s === "missing").length;
  const note = stale ? `\n(${stale} stale claim(s) were excluded; their sources changed.)` : "";
  return renderContext(doc, { status: claimStatus, budget }) + note;
}

function expandText(doc: HcsDocument, cache: SourceCache, reports: ItemReport[], id: string, maxLines: number): string {
  const item = doc.claims.find((c) => c.id === id) ?? doc.probes.find((p) => p.id === id);
  if (!item) throw new Error(`no claim or probe "${id}"`);
  const report = reports.find((r) => r.id === id)!;
  const head = "text" in item ? `${id}: ${item.text}` : `${id}: ${item.question}`;
  const parts = [`${head}\nstatus: ${report.status}`];
  report.anchors.forEach((ar) => {
    parts.push(`\n--- ${formatAnchor(ar.anchor, false)} [${ar.status}${ar.detail ? `: ${ar.detail}` : ""}]`);
    parts.push(excerpt(cache, ar.anchor.path, rangeOf(cache, ar.anchor, ar.relocated), maxLines));
  });
  return parts.join("\n");
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
export async function serveStdio(file: string, opts: ServerOptions = {}): Promise<void> {
  const server = new HcsMcpServer(resolve(file), { ...opts, root: opts.root && resolve(opts.root) });
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

// Parser and serializer for the .hcs text format (see SPEC.md).

export const FORMAT_VERSION = "0.3";
export const MAGIC = `HCS/${FORMAT_VERSION}`;
/**
 * Versions this reader accepts. 0.2 added `path::Symbol` anchors, 0.3 added probe tags (`?id[known] ...`).
 * Older files are valid newer files. The writer emits the oldest version that can express the document.
 */
export const SUPPORTED_VERSIONS = ["0.1", "0.2", "0.3"];

export interface Anchor {
  path: string;
  /** Named code symbol or Markdown heading (`path::Name`); exclusive with a line range. */
  symbol?: string;
  /** 1-based inclusive line range; undefined (and no symbol) means the whole file. */
  start?: number;
  end?: number;
  /** Truncated SHA-256 of the normalized anchored text; undefined means unsealed. */
  hash?: string;
}

export interface Claim {
  id: string;
  text: string;
  tags: string[];
  section?: string;
  anchors: Anchor[];
}

export interface Probe {
  id: string;
  question: string;
  answer: string;
  anchors: Anchor[];
  claims: string[];
  /** Optional tags (since 0.3), e.g. `known`: models answer it correctly without any context. */
  tags?: string[];
}

export interface Certificate {
  fields: Record<string, string>;
}

export interface HcsDocument {
  headers: Record<string, string>;
  /** Extra free-form `@meta key=value` entries. */
  meta: Record<string, string>;
  claims: Claim[];
  probes: Probe[];
  certificates: Certificate[];
}

export class HcsSyntaxError extends Error {
  constructor(public line: number, message: string) {
    super(`line ${line}: ${message}`);
  }
}

export function emptyDocument(title = "Untitled"): HcsDocument {
  return {
    headers: { title, root: ".", created: new Date().toISOString() },
    meta: {},
    claims: [],
    probes: [],
    certificates: [],
  };
}

const ANCHOR_RE = /^(?:"([^"]+)"|([^\s"]+?))(?:::(?:"([^"]+)"|([^\s"#]+))|:(\d+)(?:-(\d+))?)?(?:\s+#([0-9a-f]{6,64}))?$/;

export function parseAnchor(raw: string, line = 0): Anchor {
  const m = ANCHOR_RE.exec(raw.trim());
  if (!m) throw new HcsSyntaxError(line, `invalid anchor "${raw.trim()}"`);
  const path = m[1] ?? m[2];
  const anchor: Anchor = { path };
  const symbol = m[3] ?? m[4];
  if (symbol) anchor.symbol = symbol;
  if (m[5]) {
    anchor.start = Number(m[5]);
    anchor.end = m[6] ? Number(m[6]) : anchor.start;
    if (anchor.start < 1 || anchor.end < anchor.start) {
      throw new HcsSyntaxError(line, `invalid line range in anchor "${raw.trim()}"`);
    }
  }
  if (m[7]) anchor.hash = m[7];
  return anchor;
}

export function formatAnchor(a: Anchor, withHash = true): string {
  let s = /\s/.test(a.path) ? `"${a.path}"` : a.path;
  if (a.symbol !== undefined) s += /[\s"#]/.test(a.symbol) ? `::"${a.symbol.replace(/"/g, "'")}"` : `::${a.symbol}`;
  else if (a.start !== undefined) s += a.end !== undefined && a.end !== a.start ? `:${a.start}-${a.end}` : `:${a.start}`;
  if (withHash && a.hash) s += ` #${a.hash}`;
  return s;
}

function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w[\w.-]*)=("([^"]*)"|\S+)/g)) {
    out[m[1]] = m[3] ?? m[2];
  }
  return out;
}

export function parse(text: string): HcsDocument {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const doc: HcsDocument = { headers: {}, meta: {}, claims: [], probes: [], certificates: [] };
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const magic = /^HCS\/(\d+\.\d+)$/.exec(lines[i]?.trim() ?? "");
  if (!magic || !SUPPORTED_VERSIONS.includes(magic[1])) {
    const found = lines[i]?.trim() ?? "";
    if (/^HCS\/\d/.test(found)) throw new HcsSyntaxError(i + 1, `unsupported version "${found}", this tool reads ${SUPPORTED_VERSIONS.map((v) => `HCS/${v}`).join(", ")}`);
    throw new HcsSyntaxError(i + 1, `missing "${MAGIC}" magic line`);
  }
  let block: "header" | "claims" | "probes" | "certificates" = "header";
  let section: string | undefined;
  let current: Claim | Probe | undefined;
  const ids = new Set<string>();

  for (i = i + 1; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    const t = raw.trim();
    if (t === "" || t.startsWith("//")) continue;

    const blockMatch = /^\[(claims|probes|certificates)\]$/.exec(t);
    if (blockMatch) {
      block = blockMatch[1] as typeof block;
      current = undefined;
      section = undefined;
      continue;
    }

    if (block === "header") {
      const m = /^@([\w-]+)\s*(.*)$/.exec(t);
      if (!m) throw new HcsSyntaxError(n, `expected a header line "@key value", got "${t}"`);
      if (m[1] === "meta") Object.assign(doc.meta, parseKeyValues(m[2]));
      else doc.headers[m[1]] = m[2];
      continue;
    }

    if (block === "certificates") {
      const m = /^!score(?:\s+(.*))?$/.exec(t);
      if (!m) throw new HcsSyntaxError(n, `expected "!score key=value ...", got "${t}"`);
      doc.certificates.push({ fields: parseKeyValues(m[1] ?? "") });
      continue;
    }

    const indented = /^\s/.test(raw);
    if (indented) {
      if (!current) throw new HcsSyntaxError(n, "indented line outside of a claim or probe");
      if (t.startsWith(">")) {
        current.anchors.push(parseAnchor(t.slice(1), n));
      } else if (block === "probes" && t.startsWith("=")) {
        const p = current as Probe;
        const ans = t.slice(1).trim();
        if (ans) p.answer = p.answer ? `${p.answer} ${ans}` : ans;
      } else if (block === "probes" && t.startsWith("~")) {
        (current as Probe).claims.push(...t.slice(1).trim().split(/[\s,]+/).filter(Boolean));
      } else if (t.startsWith("|")) {
        // Continuation of the claim text or probe question.
        const more = t.slice(1).trim();
        if (!more) continue;
        if (block === "claims") (current as Claim).text += ` ${more}`;
        else (current as Probe).question += ` ${more}`;
      } else {
        throw new HcsSyntaxError(n, `unexpected line "${t}"`);
      }
      continue;
    }

    if (block === "claims") {
      if (t.startsWith("## ")) {
        section = t.slice(3).trim();
        current = undefined;
        continue;
      }
      const m = /^#([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?\s+(.+)$/.exec(t);
      if (!m) throw new HcsSyntaxError(n, `expected a claim "#id text", got "${t}"`);
      if (ids.has(m[1])) throw new HcsSyntaxError(n, `duplicate id "${m[1]}"`);
      ids.add(m[1]);
      const claim: Claim = {
        id: m[1],
        text: m[3].trim(),
        tags: m[2] ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : [],
        anchors: [],
      };
      if (section) claim.section = section;
      doc.claims.push(claim);
      current = claim;
      continue;
    }

    // probes
    const m = /^\?([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?\s+(.+)$/.exec(t);
    if (!m) throw new HcsSyntaxError(n, `expected a probe "?id question", got "${t}"`);
    if (ids.has(m[1])) throw new HcsSyntaxError(n, `duplicate id "${m[1]}"`);
    ids.add(m[1]);
    const probe: Probe = { id: m[1], question: m[3].trim(), answer: "", anchors: [], claims: [] };
    const tags = m[2]?.split(",").map((x) => x.trim()).filter(Boolean);
    if (tags?.length) probe.tags = tags;
    doc.probes.push(probe);
    current = probe;
  }

  for (const p of doc.probes) {
    if (!p.answer) throw new HcsSyntaxError(0, `probe "${p.id}" has no "= expected answer" line`);
  }
  return doc;
}

export function serialize(doc: HcsDocument): string {
  const probeTags = doc.probes.some((p) => p.tags?.length);
  const out: string[] = [probeTags ? MAGIC : "HCS/0.2"];
  const order = ["title", "root", "created", "updated", "generator", "source-files", "source-tokens"];
  const keys = [...order.filter((k) => k in doc.headers), ...Object.keys(doc.headers).filter((k) => !order.includes(k))];
  for (const k of keys) out.push(`@${k} ${doc.headers[k]}`.trimEnd());
  if (Object.keys(doc.meta).length) {
    out.push(`@meta ${Object.entries(doc.meta).map(([k, v]) => `${k}=${quote(v)}`).join(" ")}`);
  }

  out.push("", "[claims]");
  let section: string | undefined;
  for (const c of doc.claims) {
    if (c.section !== section) {
      section = c.section;
      if (section) out.push("", `## ${section}`);
    }
    out.push(`#${c.id}${c.tags.length ? `[${c.tags.join(",")}]` : ""} ${c.text}`);
    for (const a of c.anchors) out.push(`  > ${formatAnchor(a)}`);
  }

  if (doc.probes.length) {
    out.push("", "[probes]");
    for (const p of doc.probes) {
      out.push(`?${p.id}${p.tags?.length ? `[${p.tags.join(",")}]` : ""} ${p.question}`, `  = ${p.answer}`);
      for (const a of p.anchors) out.push(`  > ${formatAnchor(a)}`);
      if (p.claims.length) out.push(`  ~ ${p.claims.join(" ")}`);
    }
  }

  if (doc.certificates.length) {
    out.push("", "[certificates]");
    for (const c of doc.certificates) {
      out.push(`!score ${Object.entries(c.fields).map(([k, v]) => `${k}=${quote(v)}`).join(" ")}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Key=value values have no escapes: double quotes become single quotes, then values with spaces are quoted. */
function quote(v: string): string {
  const safe = v.replace(/"/g, "'");
  return /\s/.test(safe) ? `"${safe}"` : safe;
}

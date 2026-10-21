// Runs one conformance case with the TypeScript reference implementation and returns its result as plain JSON.
// Shared by generate.mjs (writes expected.json) and run.mjs (compares with it). Needs `npm run build`.

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocument, currentHash, normalizeLines, rootDir, seal, SourceCache } from "../dist/src/anchors.js";
import { dependencies, depsHash } from "../dist/src/deps.js";
import { HcsSyntaxError, parse, parseAnchor, serialize } from "../dist/src/format.js";
import { renderContext } from "../dist/src/render.js";
import { hashForCertificate } from "../dist/src/score.js";
import { findSymbol, listSymbols } from "../dist/src/symbols.js";

/** Drop undefined fields so the JSON is canonical. */
const plain = (x) => JSON.parse(JSON.stringify(x));

const claimStatus = (reports) => new Map(reports.filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));

/**
 * Cases run on a copy outside any git repository, because source discovery for cross-file moves must not
 * depend on `git ls-files`.
 */
export function withCopy(caseDir, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "hcs-conformance-"));
  try {
    cpSync(caseDir, tmp, { recursive: true });
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runCase(dir) {
  const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  const args = spec.args ?? {};
  const input = join(dir, "input.hcs");
  const load = () => parse(readFileSync(input, "utf8"));
  const docAndCache = () => {
    const doc = load();
    return { doc, cache: new SourceCache(rootDir(doc, input)) };
  };
  switch (spec.op) {
    case "parse":
      try {
        return { ok: true, document: plain(load()) };
      } catch (e) {
        if (e instanceof HcsSyntaxError) return { ok: false, line: e.line };
        throw e;
      }
    case "serialize":
      return { text: serialize(load()) };
    case "symbols": {
      const lines = normalizeLines(readFileSync(join(dir, "src", args.file), "utf8"));
      return { symbols: plain(listSymbols(args.file, lines)) };
    }
    case "find": {
      const cache = new SourceCache(join(dir, "src"));
      return { results: args.queries.map(([file, symbol]) => plain(cache.symbol(file, symbol))) };
    }
    case "hash": {
      const cache = new SourceCache(join(dir, "src"));
      return { hashes: args.anchors.map((a) => currentHash(parseAnchor(a), cache)) };
    }
    case "deps": {
      const cache = new SourceCache(join(dir, "src"));
      return {
        results: args.anchors.map((raw) => {
          const a = parseAnchor(raw);
          return { dependencies: dependencies(a, cache), hash: depsHash(a, cache) ?? null };
        }),
      };
    }
    case "check": {
      const { doc, cache } = docAndCache();
      return {
        items: checkDocument(doc, cache).map((r) => ({
          kind: r.kind,
          id: r.id,
          status: r.status,
          anchors: r.anchors.map((a) => plain({ status: a.status, relocated: a.relocated })),
        })),
      };
    }
    case "seal": {
      const { doc, cache } = docAndCache();
      const result = seal(doc, cache, { rehash: !!args.rehash, ids: args.ids ? new Set(args.ids) : undefined, deps: !!args.deps });
      return { result, text: serialize(doc) };
    }
    case "render": {
      const { doc, cache } = docAndCache();
      const status = claimStatus(checkDocument(doc, cache));
      return { text: renderContext(doc, { status, keepStale: args.keepStale, anchors: args.anchors, budget: args.budget }) };
    }
    case "digest": {
      const { doc, cache } = docAndCache();
      const status = claimStatus(checkDocument(doc, cache));
      return {
        certificates: doc.certificates.map((c) => {
          const budget = c.fields.budget ? Number(c.fields.budget) : undefined;
          const digest = hashForCertificate(doc, status, budget);
          return { digest, current: digest === c.fields.digest };
        }),
      };
    }
    default:
      throw new Error(`unknown op ${spec.op}`);
  }
}

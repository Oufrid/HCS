#!/usr/bin/env python3
"""Differential check of the Python implementation against the TypeScript reference, beyond the fixed cases:

1. symbols of every source file of this repository;
2. statuses, renders (full and at a budget), certificate digests and serialization of real .hcs files;
3. parse results and serialization of randomly mutated .hcs files (fixed seed).

Needs Node.js and `npm run build`. Run from the repository root:  python3 conformance/cross_check.py
"""

import json
import os
import random
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from hcs import (  # noqa: E402
    HcsSyntaxError,
    SourceCache,
    check_document,
    hash_for_certificate,
    list_symbols,
    normalize_lines,
    parse,
    render_context,
    root_dir,
    serialize,
)
from hcs.deps import dependencies, deps_hash, supports_deps  # noqa: E402
from hcs.sources import collect_sources  # noqa: E402

NODE = r"""
import { checkDocument, normalizeLines, rootDir, SourceCache } from "./dist/src/anchors.js";
import { HcsSyntaxError, parse, serialize } from "./dist/src/format.js";
import { renderContext } from "./dist/src/render.js";
import { hashForCertificate } from "./dist/src/score.js";
import { collectSources } from "./dist/src/sources.js";
import { listSymbols } from "./dist/src/symbols.js";
import { dependencies, depsHash, supportsDeps } from "./dist/src/deps.js";
import { readFileSync } from "node:fs";
const job = JSON.parse(readFileSync(0, "utf8"));
const plain = (x) => JSON.parse(JSON.stringify(x));
const out = { files: collectSources("."), symbols: {}, deps: {}, documents: {}, fuzz: [] };
const repo = new SourceCache(".");
for (const f of out.files) {
  out.symbols[f] = listSymbols(f, normalizeLines(readFileSync(f, "utf8")));
  if (supportsDeps(f)) out.deps[f] = out.symbols[f].map((s) => { const a = { path: f, symbol: s.name }; return [dependencies(a, repo), depsHash(a, repo) ?? null]; });
}
for (const f of job.documents) {
  const doc = parse(readFileSync(f, "utf8"));
  const reports = checkDocument(doc, new SourceCache(rootDir(doc, f)));
  const st = new Map(reports.filter((r) => r.kind === "claim").map((r) => [r.id, r.status]));
  out.documents[f] = {
    statuses: reports.map((r) => [r.id, r.status]),
    render: renderContext(doc, { status: st }),
    budget: renderContext(doc, { status: st, budget: 1000 }),
    digests: doc.certificates.map((c) => hashForCertificate(doc, st, c.fields.budget ? Number(c.fields.budget) : undefined)),
    serialized: serialize(doc),
  };
}
for (const t of job.fuzz) {
  try {
    const d = parse(t);
    out.fuzz.push({ ok: true, doc: plain(d), serialized: serialize(d) });
  } catch (e) {
    out.fuzz.push(e instanceof HcsSyntaxError ? { ok: false, line: e.line } : { crash: String(e) });
  }
}
process.stdout.write(JSON.stringify(out));
"""

TOKENS = ["HCS/0.2", "HCS/0.3", "[claims]", "[probes]", "[certificates]", "#", "?", "!score", "@", "> ", "  ", "=", "~",
          "|", "::", ":", "-", "#ffffff", "0", '"', "[", "]", ",", "\n", "\r\n", "\t", "é", "😀", " ", "a" * 50, "## ", "//"]


def mutate(s, rnd):
    for _ in range(rnd.randint(1, 8)):
        p = rnd.randint(0, len(s))
        op = rnd.randint(0, 4)
        if op == 0:
            s = s[:p] + s[p + 1 + rnd.randint(0, 20):]
        elif op == 1:
            s = s[:p] + rnd.choice(TOKENS) + s[p:]
        elif op == 2:
            s = s[:p] + chr(rnd.randint(32, 0x3000)) + s[p + 1:]
        elif op == 3:
            lines = s.split("\n")
            a, b = rnd.randrange(len(lines)), rnd.randrange(len(lines))
            lines[a], lines[b] = lines[b], lines[a]
            s = "\n".join(lines)
        else:
            s = s[:p]
    return s


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def main():
    os.chdir(ROOT)
    documents = [f for f in ["project.hcs", "bench/a1/gemini.hcs", "bench/a1/groq.hcs"] if os.path.exists(f)]
    seeds = [read(f) for f in documents]
    cases = os.path.join("conformance", "cases")
    seeds += [read(os.path.join(cases, c, "input.hcs")) for c in sorted(os.listdir(cases)) if os.path.exists(os.path.join(cases, c, "input.hcs"))]
    rnd = random.Random(7)
    fuzz = [mutate(rnd.choice(seeds), rnd) for _ in range(3000)]
    job = json.dumps({"documents": documents, "fuzz": fuzz})
    ts = json.loads(subprocess.run(["node", "--input-type=module", "-e", NODE], input=job.encode(), stdout=subprocess.PIPE, check=True).stdout)

    failures = []
    files = collect_sources(".")
    if files != ts["files"]:
        failures.append("source file lists differ")
    n_symbols = 0
    n_deps = 0
    repo = SourceCache(".")
    for f in files:
        syms = list_symbols(f, normalize_lines(read(f)))
        n_symbols += len(syms)
        if syms != ts["symbols"].get(f):
            failures.append("symbols differ in " + f)
        if supports_deps(f):
            mine = []
            for s in syms:
                a = {"path": f, "symbol": s["name"]}
                mine.append([dependencies(a, repo), deps_hash(a, repo)])
                n_deps += len(mine[-1][0])
            if mine != ts["deps"].get(f):
                failures.append("dependencies differ in " + f)
    for f in documents:
        doc = parse(read(f))
        reports = check_document(doc, SourceCache(root_dir(doc, f)))
        st = {r["id"]: r["status"] for r in reports if r["kind"] == "claim"}
        mine = {
            "statuses": [[r["id"], r["status"]] for r in reports],
            "render": render_context(doc, st),
            "budget": render_context(doc, st, budget=1000),
            "digests": [hash_for_certificate(doc, st, int(c["fields"]["budget"]) if c["fields"].get("budget") else None) for c in doc["certificates"]],
            "serialized": serialize(doc),
        }
        for k, v in mine.items():
            if v != ts["documents"][f][k]:
                failures.append("%s differs for %s" % (k, f))
    for i, t in enumerate(fuzz):
        try:
            d = parse(t)
            mine = {"ok": True, "doc": d, "serialized": serialize(d)}
        except HcsSyntaxError as e:
            mine = {"ok": False, "line": e.line}
        if mine != ts["fuzz"][i]:
            failures.append("fuzz input %d parses differently" % i)

    print("cross-check: %d files, %d symbols, %d dependency edges, %d documents, %d mutated inputs" % (len(files), n_symbols, n_deps, len(documents), len(fuzz)))
    for f in failures[:20]:
        print("  DIFF " + f)
    print("OK: the Python implementation matches the TypeScript reference" if not failures else "FAIL: %d difference(s)" % len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

"""Runs the language-agnostic conformance suite (../../conformance/cases) against the Python implementation.

    python -m unittest discover -s python/tests -v
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from hcs import (  # noqa: E402
    HcsSyntaxError,
    SourceCache,
    check_document,
    current_hash,
    hash_for_certificate,
    list_symbols,
    normalize_lines,
    parse,
    parse_anchor,
    render_context,
    root_dir,
    seal,
    serialize,
)

CASES = os.path.join(os.path.dirname(os.path.dirname(HERE)), "conformance", "cases")


def _read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _claim_status(reports):
    return {r["id"]: r["status"] for r in reports if r["kind"] == "claim"}


def run_case(d):
    spec = json.loads(_read(os.path.join(d, "case.json")))
    args = spec.get("args", {})
    op = spec["op"]
    hcs_file = os.path.join(d, "input.hcs")

    def doc_and_cache():
        doc = parse(_read(hcs_file))
        return doc, SourceCache(root_dir(doc, hcs_file))

    if op == "parse":
        try:
            return {"ok": True, "document": parse(_read(hcs_file))}
        except HcsSyntaxError as e:
            return {"ok": False, "line": e.line}
    if op == "serialize":
        return {"text": serialize(parse(_read(hcs_file)))}
    if op == "symbols":
        lines = normalize_lines(_read(os.path.join(d, "src", args["file"])))
        return {"symbols": list_symbols(args["file"], lines)}
    if op == "find":
        cache = SourceCache(os.path.join(d, "src"))
        return {"results": [cache.symbol(f, s) for f, s in args["queries"]]}
    if op == "hash":
        cache = SourceCache(os.path.join(d, "src"))
        return {"hashes": [current_hash(parse_anchor(a), cache) for a in args["anchors"]]}
    if op == "check":
        doc, cache = doc_and_cache()
        items = []
        for r in check_document(doc, cache):
            anchors = []
            for a in r["anchors"]:
                entry = {"status": a["status"]}
                if a.get("relocated"):
                    entry["relocated"] = a["relocated"]
                anchors.append(entry)
            items.append({"kind": r["kind"], "id": r["id"], "status": r["status"], "anchors": anchors})
        return {"items": items}
    if op == "seal":
        doc, cache = doc_and_cache()
        result = seal(doc, cache, rehash=bool(args.get("rehash")), ids=set(args["ids"]) if args.get("ids") else None)
        return {"result": result, "text": serialize(doc)}
    if op == "render":
        doc, cache = doc_and_cache()
        status = _claim_status(check_document(doc, cache))
        return {
            "text": render_context(
                doc, status, keep_stale=bool(args.get("keepStale")), anchors=args.get("anchors", True) is not False, budget=args.get("budget")
            )
        }
    if op == "digest":
        doc, cache = doc_and_cache()
        status = _claim_status(check_document(doc, cache))
        out = []
        for c in doc["certificates"]:
            budget = int(c["fields"]["budget"]) if c["fields"].get("budget") else None
            digest = hash_for_certificate(doc, status, budget)
            out.append({"digest": digest, "current": digest == c["fields"].get("digest")})
        return {"certificates": out}
    raise ValueError("unknown op " + op)


def run_in_copy(d):
    # Same as the reference runner: outside any git repository, so source discovery does not use git.
    tmp = tempfile.mkdtemp(prefix="hcs-conformance-")
    try:
        copy = os.path.join(tmp, "case")
        shutil.copytree(d, copy)
        return run_case(copy)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class Conformance(unittest.TestCase):
    pass


def _make_test(name):
    def test(self):
        d = os.path.join(CASES, name)
        expected = json.loads(_read(os.path.join(d, "expected.json")))
        self.maxDiff = None
        self.assertEqual(run_in_copy(d), expected)

    return test


for _name in sorted(os.listdir(CASES)):
    setattr(Conformance, "test_" + _name.replace("-", "_"), _make_test(_name))


if __name__ == "__main__":
    unittest.main()

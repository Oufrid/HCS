"""Command line for the deterministic commands: validate, check, seal, render.

Exit codes as in the TypeScript CLI: 0 ok, 1 verification failed, 2 usage or syntax error.
"""

import argparse
import datetime
import json
import os
import sys

from .anchors import SourceCache, check_document, root_dir, seal
from .format import HcsSyntaxError, format_anchor, parse, serialize
from .guard import injection_findings
from .render import DECODER_PROMPT, hash_for_certificate, render_context
from .sign import check_signature, document_keys, parse_trusted_keys


def _load(path):
    if not os.path.exists(path):
        raise FileNotFoundError("file not found: " + path)
    with open(path, encoding="utf-8") as f:
        return parse(f.read())


def _check(args):
    doc = _load(args.file)
    reports = check_document(doc, SourceCache(root_dir(doc, args.file)))
    status = {r["id"]: r["status"] for r in reports if r["kind"] == "claim"}
    suspect = {c["id"] for c in doc["claims"] if "suspect" in c["tags"] or any(f["severity"] == "high" for f in injection_findings(c["text"]))}
    failing = [
        r for r in reports if r["status"] in ("stale", "missing") or (args.strict and (r["status"] == "unsealed" or r["id"] in suspect))
    ]
    trusted = {}
    for path in (args.trusted, os.environ.get("HCS_TRUSTED_KEYS")):
        if path:
            with open(path, encoding="utf-8") as f:
                trusted.update(parse_trusted_keys(f.read()))
    declared = document_keys(doc)
    certificates = []
    for c in doc["certificates"]:
        budget = int(c["fields"]["budget"]) if c["fields"].get("budget") else None
        certificates.append(
            {"fields": c["fields"], "current": hash_for_certificate(doc, status, budget) == c["fields"].get("digest"), "signature": check_signature(c, trusted, declared)}
        )
    tampered = sum(1 for c in certificates if c["signature"]["status"] == "invalid")
    if args.json:
        items = [{"kind": r["kind"], "id": r["id"], "status": r["status"]} for r in reports]
        print(json.dumps({"file": args.file, "items": items, "certificates": certificates, "ok": not failing and not tampered}, indent=2))
        return 1 if failing or tampered else 0
    print("%s: %d claims, %d probes" % (args.file, len(doc["claims"]), len(doc["probes"])))
    for kind in ("claim", "probe"):
        counts = [(s, sum(1 for r in reports if r["kind"] == kind and r["status"] == s)) for s in ("ok", "moved", "unsealed", "stale", "missing")]
        parts = ["%d %s" % (n, s) for s, n in counts if n]
        if parts:
            print("  %ss: %s" % (kind, ", ".join(parts)))
    for r in reports:
        for a in r["anchors"]:
            if a["status"] != "ok":
                print("  %-8s %-6s %s  %s" % (a["status"].upper() if a["status"] in ("stale", "missing") else a["status"], r["id"], format_anchor(a["anchor"], False), a.get("detail", "")))
    for c in certificates:
        sig = c["signature"]
        label = {"unsigned": "", "trusted": ", signed by trusted key %s", "untrusted": ", signed by %s (key declared in this file, not trusted)",
                 "invalid": ", SIGNATURE INVALID (edited after %s signed it)", "unknown-key": ", signed by an unknown key"}[sig["status"]]
        label = label % sig["signer"] if "%s" in label else label
        print("  certificate %s fidelity=%s: %s%s" % (c["fields"].get("model"), c["fields"].get("fidelity"), "current" if c["current"] else "OUTDATED", label))
    if tampered:
        print("FAIL: %d signed certificate(s) were edited after signing." % tampered)
    if failing:
        print("FAIL: %d item(s) no longer match their sources." % len(failing))
        return 1
    if tampered:
        return 1
    print("OK: every claim still matches its sources.")
    return 0


def _seal(args):
    doc = _load(args.file)
    ids = {i.strip() for i in args.ids.split(",")} if args.ids else None
    r = seal(doc, SourceCache(root_dir(doc, args.file)), rehash=args.rehash, ids=ids)
    if r["sealed"] + r["relocated"] + r["rehashed"]:
        if r["rehashed"]:
            doc["certificates"] = []
        doc["headers"]["updated"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        with open(args.file, "w", encoding="utf-8") as f:
            f.write(serialize(doc))
    print("%s: %d sealed, %d relocated, %d re-hashed" % (args.file, r["sealed"], r["relocated"], r["rehashed"]))
    return 0


def _render(args):
    doc = _load(args.file)
    reports = check_document(doc, SourceCache(root_dir(doc, args.file)))
    status = {r["id"]: r["status"] for r in reports if r["kind"] == "claim"}
    text = render_context(doc, status, keep_stale=args.keep_stale, anchors=not args.no_anchors, budget=args.budget)
    print(DECODER_PROMPT + "\n\n" + text if args.decoder else text)
    return 0


def _validate(args):
    doc = _load(args.file)
    print("%s: valid (%d claims, %d probes, %d certificates)" % (args.file, len(doc["claims"]), len(doc["probes"]), len(doc["certificates"])))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hcs-py", description="HCS deterministic commands (Python implementation).")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("validate", help="check syntax")
    p.add_argument("file")
    p.set_defaults(run=_validate)
    p = sub.add_parser("check", help="verify every anchor against the sources; exit 1 if stale")
    p.add_argument("file")
    p.add_argument("--strict", action="store_true", help="also fail on unsealed anchors and suspect claims")
    p.add_argument("--json", action="store_true")
    p.add_argument("--trusted", help="file of trusted public keys (name ed25519:...), to verify signed certificates")
    p.set_defaults(run=_check)
    p = sub.add_parser("seal", help="hash unsealed anchors, follow moved ones")
    p.add_argument("file")
    p.add_argument("--rehash", action="store_true", help="accept the current content of stale anchors")
    p.add_argument("--ids", help="comma-separated ids to seal")
    p.set_defaults(run=_seal)
    p = sub.add_parser("render", help="print the context block")
    p.add_argument("file")
    p.add_argument("--budget", type=int)
    p.add_argument("--decoder", action="store_true")
    p.add_argument("--no-anchors", action="store_true")
    p.add_argument("--keep-stale", action="store_true")
    p.set_defaults(run=_render)
    args = parser.parse_args(argv)
    try:
        return args.run(args)
    except (HcsSyntaxError, FileNotFoundError) as e:
        print("hcs: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

"""Deterministic anchor verification: hashing, relocation and staleness (a port of src/anchors.ts)."""

import hashlib
import os
import re

from .sources import collect_sources
from .symbols import find_symbol, language_of, list_symbols

HASH_LENGTH = 12
SEVERITY = ["ok", "moved", "unsealed", "stale", "missing"]


def normalize_lines(text):
    """Stable across CRLF/LF and trailing whitespace; trailing blank lines are dropped."""
    lines = [re.sub(r"\s+$", "", l) for l in re.sub(r"\r\n?", "\n", text).split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def hash_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:HASH_LENGTH]


def hash_lines(lines):
    return hash_text("\n".join(lines))


def hash_symbol_lines(lines):
    """Symbol anchors hash with all whitespace removed, so reformatting does not break them."""
    return hash_text(re.sub(r"\s+", "", "\n".join(lines)))


def anchor_hash(a, lines):
    return hash_symbol_lines(lines) if "symbol" in a else hash_lines(lines)


def root_dir(doc, hcs_path):
    """Directory against which anchor paths are resolved."""
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(hcs_path)), doc["headers"].get("root") or "."))


def _escapes(rel):
    return rel in ("", ".", "..") or os.path.isabs(rel) or rel.startswith(".." + os.sep)


def inside_root(root, path):
    """Resolve `path` against the root and refuse anything outside it, including through symlinks."""
    full = os.path.normpath(os.path.join(root, path))
    rel = os.path.relpath(full, root)
    if _escapes(rel):
        raise ValueError("path must be inside the project root")
    if os.path.exists(full) and _escapes(os.path.relpath(os.path.realpath(full), os.path.realpath(root))):
        raise ValueError("path must be inside the project root")
    return rel


class SourceCache:
    def __init__(self, root):
        self.root = root
        self._files = {}
        self._file_list = None

    def lines(self, path):
        """Lines of a file under the root; None when it does not exist or lies outside the root."""
        if path not in self._files:
            try:
                full = os.path.join(self.root, inside_root(self.root, path))
            except ValueError:
                full = None
            if not full or not os.path.isfile(full):
                self._files[path] = None
            else:
                with open(full, encoding="utf-8", newline="") as f:
                    self._files[path] = normalize_lines(f.read())
        return self._files[path]

    def source_files(self):
        if self._file_list is None:
            self._file_list = collect_sources(self.root)
        return self._file_list

    def symbol(self, path, symbol):
        lines = self.lines(path)
        return find_symbol(path, lines, symbol) if lines is not None else None

    def slice(self, a):
        """Text covered by an anchor, or None when the file, range or symbol does not exist."""
        lines = self.lines(a["path"])
        if lines is None:
            return None
        if "symbol" in a:
            r = find_symbol(a["path"], lines, a["symbol"])
            return lines[r["start"] - 1 : r["end"]] if r else None
        if "start" not in a:
            return lines
        end = a.get("end", a["start"])
        if end > len(lines):
            return None
        return lines[a["start"] - 1 : end]


def current_hash(a, cache):
    s = cache.slice(a)
    return anchor_hash(a, s) if s is not None else None


def _find_moved_symbol(a, cache):
    if not a.get("symbol") or not a.get("hash"):
        return None
    short = a["symbol"].split(".")[-1]
    lang = language_of(a["path"])
    for f in cache.source_files():
        if f == a["path"] or language_of(f) != lang:
            continue
        lines = cache.lines(f)
        if not lines or not any(short in l for l in lines):
            continue
        for s in list_symbols(f, lines):
            if s["name"].split(".")[-1] != short and s["name"] != a["symbol"]:
                continue
            if hash_symbol_lines(lines[s["start"] - 1 : s["end"]]) == a["hash"]:
                return {"path": f, "symbol": s["name"]}
    return None


def _check_symbol_anchor(a, cache):
    lines = cache.lines(a["path"])
    rng = find_symbol(a["path"], lines, a["symbol"]) if lines is not None else None
    if rng and not a.get("hash"):
        return {"anchor": a, "status": "unsealed", "detail": "anchor has no hash; run `hcs seal`"}
    if rng and lines is not None:
        if hash_symbol_lines(lines[rng["start"] - 1 : rng["end"]]) == a["hash"]:
            return {"anchor": a, "status": "ok"}
        return {"anchor": a, "status": "stale", "detail": "symbol changed (lines %d-%d)" % (rng["start"], rng["end"])}
    moved = _find_moved_symbol(a, cache)
    if moved:
        return {"anchor": a, "status": "moved", "relocated": moved}
    if lines is None:
        return {"anchor": a, "status": "missing", "detail": "file not found"}
    return {"anchor": a, "status": "missing" if a.get("hash") else "unsealed", "detail": 'symbol "%s" not found' % a["symbol"]}


def _find_window(lines, length, hsh, origin):
    """Search outward from `origin` so the nearest matching window wins."""
    last = len(lines) - length
    if last < 0:
        return -1
    for d in range(0, max(origin, last - origin) + 1):
        for pos in ([origin] if d == 0 else [origin - d, origin + d]):
            if pos < 0 or pos > last:
                continue
            if hash_lines(lines[pos : pos + length]) == hsh:
                return pos
    return -1


def check_anchor(a, cache):
    if "symbol" in a:
        return _check_symbol_anchor(a, cache)
    lines = cache.lines(a["path"])
    if lines is None:
        return {"anchor": a, "status": "missing", "detail": "file not found"}
    if not a.get("hash"):
        return {"anchor": a, "status": "unsealed", "detail": "anchor has no hash; run `hcs seal`"}
    sl = cache.slice(a)
    if sl is not None and hash_lines(sl) == a["hash"]:
        return {"anchor": a, "status": "ok"}
    if "start" not in a:
        return {"anchor": a, "status": "stale", "detail": "file content changed"}
    length = a.get("end", a["start"]) - a["start"] + 1
    found = _find_window(lines, length, a["hash"], a["start"] - 1)
    if found != -1:
        return {"anchor": a, "status": "moved", "relocated": {"start": found + 1, "end": found + length}}
    detail = "anchored text changed" if sl is not None else "range beyond end of file (%d lines)" % len(lines)
    return {"anchor": a, "status": "stale", "detail": detail}


def worst(statuses):
    w = "ok"
    for s in statuses:
        if SEVERITY.index(s) > SEVERITY.index(w):
            w = s
    return w


def check_item(item, kind, cache):
    anchors = [check_anchor(a, cache) for a in item["anchors"]]
    return {"kind": kind, "id": item["id"], "status": worst([r["status"] for r in anchors]), "anchors": anchors}


def check_document(doc, cache):
    """One report per claim, then per probe: {"kind", "id", "status", "anchors": [{"anchor", "status", ...}]}."""
    return [check_item(c, "claim", cache) for c in doc["claims"]] + [check_item(p, "probe", cache) for p in doc["probes"]]


def seal(doc, cache, rehash=False, ids=None):
    """Hash unsealed anchors, follow moved ones and, with rehash, accept the current content of stale ones."""
    result = {"sealed": 0, "relocated": 0, "rehashed": 0}
    for item in doc["claims"] + doc["probes"]:
        if ids is not None and item["id"] not in ids:
            continue
        for a in item["anchors"]:
            r = check_anchor(a, cache)
            if r["status"] == "unsealed":
                h = current_hash(a, cache)
                if h:
                    a["hash"] = h
                    result["sealed"] += 1
            elif r["status"] == "moved" and r.get("relocated"):
                rel = r["relocated"]
                if "path" in rel:
                    a["path"] = rel["path"]
                if "symbol" in rel:
                    a["symbol"] = rel["symbol"]
                if "start" in rel:
                    a["start"] = rel["start"]
                    a["end"] = rel["end"]
                result["relocated"] += 1
            elif r["status"] == "stale" and rehash:
                h = current_hash(a, cache)
                if h:
                    a["hash"] = h
                    result["rehashed"] += 1
    return result

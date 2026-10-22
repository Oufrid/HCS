"""Dependency hashes for symbol anchors (port of src/deps.ts).

A claim about `fee()` may stop being true when `fee` calls a helper that changed. A symbol anchor can carry a second
hash, of the symbols its symbol uses directly, so `check` reports `review`. Heuristic: identifier matching, depth 1,
JavaScript/TypeScript and Python only.
"""

import posixpath
import re

from .anchors import hash_symbol_lines, hash_text
from .symbols import code_lines, find_symbol, list_symbols

A = re.ASCII
_JS = re.compile(r"\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$", re.I)
_PY = re.compile(r"\.(py|pyi)$", re.I)


def supports_deps(path):
    return bool(_JS.search(path) or _PY.search(path))


def _imports(path, lines):
    out = {}
    text = "\n".join(lines)
    if _JS.search(path):
        for m in re.finditer(r"""\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']""", text, A):
            for part in m.group(1).split(","):
                p = re.fullmatch(r"\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*", part, A)
                if p:
                    out[p.group(2) or p.group(1)] = (m.group(2), p.group(1))
    else:
        for m in re.finditer(r"^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+\(?([^)\n]*)\)?", text, A | re.M):
            for part in m.group(2).split(","):
                p = re.fullmatch(r"\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*", part, A)
                if p:
                    out[p.group(2) or p.group(1)] = (m.group(1), p.group(1))
    return out


def _dir(p):
    d = posixpath.dirname(p)
    return "" if d in ("", ".") else d


def _resolve(path, spec, cache):
    def exists(p):
        return p if p and not p.startswith("..") and cache.lines(p) is not None else None

    if _JS.search(path):
        if not spec.startswith("."):
            return None
        base = posixpath.normpath(posixpath.join(_dir(path), spec))
        stem = re.sub(r"\.(js|mjs|cjs|jsx)$", "", base)
        for c in [base, stem + ".ts", stem + ".tsx", stem + ".mts", stem + ".js", stem + ".jsx", stem + ".mjs", stem + "/index.ts", stem + "/index.js"]:
            hit = exists(c)
            if hit:
                return hit
        return None
    dots = len(re.match(r"\.*", spec).group(0))
    rest = "/".join(x for x in spec[dots:].split(".") if x)
    d = _dir(path) if dots else ""
    for _ in range(1, dots):
        d = _dir(d)
    base = re.sub(r"^\./?", "", posixpath.normpath(posixpath.join(d, rest)))
    return exists(base + ".py") or exists(base + "/__init__.py")


def dependencies(a, cache):
    """Symbols the anchored symbol uses directly: [{"path", "symbol"}], sorted."""
    if "symbol" not in a or not supports_deps(a["path"]):
        return []
    lines = cache.lines(a["path"])
    rng = find_symbol(a["path"], lines, a["symbol"]) if lines is not None else None
    if lines is None or not rng:
        return []
    symbols = list_symbols(a["path"], lines)
    self_name = next((s["name"] for s in symbols if s["start"] == rng["start"] and s["end"] == rng["end"]), a["symbol"])
    parent = self_name[: self_name.rindex(".")] if "." in self_name else ""
    body = "\n".join(code_lines(a["path"], lines)[rng["start"] - 1 : rng["end"]])
    used = set(re.findall(r"[A-Za-z_$][\w$]*", body, A))
    deps = {}
    for s in symbols:
        name = s["name"]
        if name == self_name or name.startswith(self_name + ".") or self_name.startswith(name + "."):
            continue
        sibling = (name[: name.rindex(".")] == parent and parent != "") if "." in name else True
        if sibling and name.split(".")[-1] in used:
            deps["%s::%s" % (a["path"], name)] = {"path": a["path"], "symbol": name}
    for local, (spec, imported) in _imports(a["path"], lines).items():
        if local not in used:
            continue
        target = _resolve(a["path"], spec, cache)
        if target:
            found = cache.symbol(target, imported)
            if found and found["name"] == imported:
                deps["%s::%s" % (target, imported)] = {"path": target, "symbol": imported}
    return [deps[k] for k in sorted(deps)]


def deps_hash(a, cache):
    """Hash of the dependencies' current text, or None when the symbol has none."""
    deps = dependencies(a, cache)
    if not deps:
        return None
    entries = []
    for d in deps:
        lines = cache.lines(d["path"])
        r = find_symbol(d["path"], lines, d["symbol"]) if lines is not None else None
        h = hash_symbol_lines(lines[r["start"] - 1 : r["end"]]) if r and lines is not None else "missing"
        entries.append("%s::%s=%s" % (d["path"], d["symbol"], h))
    return hash_text("\n".join(entries))

"""Source discovery: the files a tool may look at under a project root (used to find symbols that moved)."""

import os
import re
import subprocess

DEFAULT_IGNORES = [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "vendor/",
    ".venv/",
    "__pycache__/",
    ".hcs-cache/",
    "*.hcs",
    "*.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.svg",
]


def glob_to_regexp(pattern):
    p = pattern.strip()
    dir_only = p.endswith("/")
    if dir_only:
        p = p[:-1]
    anchored = p.startswith("/") or "/" in p
    if p.startswith("/"):
        p = p[1:]
    out = ""
    i = 0
    while i < len(p):
        ch = p[i]
        if ch == "*" and i + 1 < len(p) and p[i + 1] == "*":
            if i + 2 < len(p) and p[i + 2] == "/":
                out += "(?:.*/)?"
                i += 3
            else:
                out += ".*"
                i += 2
            continue
        if ch == "*":
            out += "[^/]*"
        elif ch == "?":
            out += "[^/]"
        else:
            out += re.escape(ch) if ch in ".+^${}()|[]\\" else ch
        i += 1
    prefix = "^" if anchored else "^(?:.*/)?"
    suffix = "/" if dir_only else "(?:/|$)"
    return re.compile(prefix + out + suffix)


def _load_ignores(root, extra=()):
    patterns = DEFAULT_IGNORES + list(extra)
    path = os.path.join(root, ".hcsignore")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            for line in f.read().splitlines():
                t = line.strip()
                if t and not t.startswith("#"):
                    patterns.append(t)
    return [glob_to_regexp(p) for p in patterns]


def _git_files(root):
    try:
        out = subprocess.run(
            ["git", "ls-files", "-co", "--exclude-standard", "-z"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
        ).stdout.decode("utf-8")
    except (OSError, subprocess.CalledProcessError):
        return None
    return [f for f in out.split("\0") if f]


def _walk(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for name in filenames:
            full = os.path.join(dirpath, name)
            if os.path.isfile(full):
                out.append(os.path.relpath(full, root).replace(os.sep, "/"))
    return out


def _is_text(path):
    with open(path, "rb") as f:
        return b"\0" not in f.read(8192)


def collect_sources(root, paths=(".",), max_bytes=256 * 1024, ignore=()):
    """Text files under `paths` (relative to `root`), honoring .gitignore inside git repos and .hcsignore."""
    abs_root = os.path.abspath(root)
    ignores = _load_ignores(abs_root, ignore)
    files = _git_files(abs_root)
    if files is None:
        files = _walk(abs_root)
    wanted = []
    for p in paths:
        rel = os.path.relpath(os.path.abspath(os.path.join(abs_root, p)), abs_root).replace(os.sep, "/")
        wanted.append("" if rel == "." else rel)
    for w in wanted:
        if w and w not in files and os.path.isfile(os.path.join(abs_root, w)):
            files.append(w)
    result = []
    for f in sorted(files):
        if not any(w == "" or f == w or f.startswith(w + "/") for w in wanted):
            continue
        if any(r.search(f) for r in ignores):
            continue
        full = os.path.join(abs_root, f)
        if not os.path.isfile(full):
            continue
        size = os.path.getsize(full)
        if size == 0 or size > max_bytes or not _is_text(full):
            continue
        result.append(f)
    return result

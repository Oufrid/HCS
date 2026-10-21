"""Dependency-free symbol locator for `path::Symbol` anchors (a port of src/symbols.ts).

Heuristic, not a parser: it covers the common shapes of brace languages, Python, Markdown, YAML and JSON.
Unknown symbols are reported as missing, never guessed. Regexes use re.ASCII where the reference relies on
JavaScript's ASCII-only \\w, \\d and \\b.
"""

import re

A = re.ASCII


def language_of(path):
    m = re.search(r"\.([A-Za-z0-9]+)$", path)
    ext = m.group(1).lower() if m else ""
    if ext in ("py", "pyi"):
        return "python"
    if ext in ("md", "mdx", "markdown"):
        return "markdown"
    if ext in ("yml", "yaml"):
        return "yaml"
    if ext in ("json", "jsonc"):
        return "json"
    return "brace"


CONTROL = {
    "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "with", "await", "new", "throw",
    "typeof", "sizeof", "elif", "except", "using", "lock", "foreach", "match", "when", "select", "defer", "go",
}

NOT_A_DEFINITION = re.compile(
    r"^\s*(?:import|from|use|using|package|require|include|#\s*include|return|throw|await|yield|new|delete|goto"
    r"|break|continue|case)\b|^\s*export\s*\{|^\s*export\s+\*",
    A,
)

BRACE_DEFS = [
    re.compile(
        r"\b(?:function\*?|class|interface|enum|struct|trait|impl|fn|func|def|type|namespace|module|object|record"
        r"|union|protocol|extension)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)",
        A,
    ),
    re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var|val|static)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=", A),
    re.compile(
        r"^\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|export|default|final|virtual"
        r"|internal|suspend|open|inline|get|set|unsafe|pub(?:\([^)]*\))?|const|extern)\s+)*"
        r"(?:[\w<>\[\],.?*&:]+\s+)*?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(",
        A,
    ),
    re.compile(r"^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)", A),
]

REGEX_PRECEDERS = {"", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"}
_CHAR_LITERAL = re.compile(r"'(\\.[^']{0,8}|[^'\\])'")


class _ScanState:
    def __init__(self, single_quote_strings=True):
        self.comment = False
        self.template = False
        self.single_quote_strings = single_quote_strings


def _find_close(line, start, q):
    j = start + 1
    while j < len(line):
        if line[j] == "\\":
            j += 1
        elif line[j] == q:
            return j
        j += 1
    return -1


def _regex_close(line, start):
    in_class = False
    j = start + 1
    while j < len(line):
        c = line[j]
        if c == "\\":
            j += 1
        elif c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            return j if j > start + 1 else -1
        j += 1
    return -1


def _code_only(line, st):
    """Strip string literals, regex literals and comments so braces and words inside them do not count."""
    out = ""
    i = 0
    n = len(line)
    while i < n:
        if st.comment:
            end = line.find("*/", i)
            if end == -1:
                return out
            st.comment = False
            i = end + 2
            continue
        if st.template:
            end = _find_close(line, i - 1, "`")
            if end == -1:
                return out
            st.template = False
            out += " "
            i = end + 1
            continue
        ch = line[i]
        nxt = line[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            break
        if ch == "#" and re.match(r"#\s", line[i:]) and out.strip() == "":
            break
        if ch == "/" and nxt == "*":
            st.comment = True
            i += 2
            continue
        if ch == "/":
            prev = re.sub(r"\s+$", "", out)
            if prev[-1:] in REGEX_PRECEDERS or re.search(r"\b(return|typeof|case)$", prev, A):
                close = _regex_close(line, i)
                if close != -1:
                    out += " "
                    i = close + 1
                    while i < n and re.match(r"[a-z]", line[i], re.I):
                        i += 1
                    continue
        if ch == '"' or ch == "`" or (ch == "'" and st.single_quote_strings):
            close = _find_close(line, i, ch)
            if close != -1:
                out += " "
                i = close + 1
                continue
            if ch == "`":
                st.template = True
                return out
        if ch == "'" and not st.single_quote_strings:
            m = _CHAR_LITERAL.match(line, i)
            if m:
                out += " "
                i += len(m.group(0))
                continue
        out += ch
        i += 1
    return out


_CONTINUES = re.compile(r"(=>|[=,(+\-*?:]|&&|\|\|)\s*$")


def _find_end(lines, start_idx, mode, single_quote_strings):
    depth = 0
    parens = 0
    opened = False
    st = _ScanState(single_quote_strings)
    opens = "{" if mode == "block" else "{[("
    closes = "}" if mode == "block" else "}])"
    i = start_idx
    while i < len(lines) and i < start_idx + 2000:
        code = _code_only(lines[i], st)
        for ch in code:
            if mode == "block" and ch == "(":
                parens += 1
            elif mode == "block" and ch == ")":
                parens = max(0, parens - 1)
            elif ch in opens and parens == 0:
                depth += 1
                opened = True
            elif ch in closes and parens == 0:
                depth -= 1
            elif ch == ";" and depth <= 0 and parens == 0:
                return i, opened
        continues = mode == "value" and bool(_CONTINUES.search(code))
        if opened and depth <= 0 and not continues:
            return i, opened
        if mode == "json" and not opened and i == start_idx:
            return i, opened
        if not opened and i > start_idx + 8:
            return start_idx, opened
        i += 1
    return (min(len(lines) - 1, start_idx + 1999) if opened else start_idx), opened


def _brace_symbols(lines, json_mode, single_quote_strings):
    out = []
    st = _ScanState(single_quote_strings)
    for i, line in enumerate(lines):
        was_inside = st.comment or st.template
        code = _code_only(line, st)
        if was_inside or not code.strip():
            continue
        name = None
        kind = -1
        if json_mode:
            m = re.match(r'\s*"([^"]+)"\s*:', line)
            name = m.group(1) if m else None
        else:
            if NOT_A_DEFINITION.search(code):
                continue
            nested = bool(re.match(r"\s", code))
            for k, rx in enumerate(BRACE_DEFS):
                m = rx.search(code)
                # After an explicit keyword the name is a definition; call-like patterns skip control words.
                if not m or (k != 0 and m.group(1) in CONTROL):
                    continue
                if k == 1 and nested:
                    continue
                if k == 2 and re.search(r"=>|\bfunction\b|,\s*$", code[m.end():], A):
                    continue
                name = m.group(1)
                kind = k
                break
        if not name:
            continue
        mode = "json" if json_mode else ("value" if kind == 1 else "block")
        end, opened = _find_end(lines, i, mode, single_quote_strings)
        if kind == 2 and not opened and not re.search(r"\)\s*:[^;]*;\s*$", code):
            continue
        out.append({"short": name, "start": i + 1, "end": end + 1})
    return out


def _indent_of(line):
    return len(re.match(r"\s*", line).group(0).replace("\t", "    "))


def _indent_symbols(lines, rx, include_decorators):
    out = []
    for i, line in enumerate(lines):
        m = rx.search(line)
        if not m:
            continue
        ind = _indent_of(line)
        end = i
        for j in range(i + 1, len(lines)):
            if lines[j].strip() == "":
                continue
            if _indent_of(lines[j]) <= ind:
                break
            end = j
        start = i
        while include_decorators and start > 0 and re.match(r"\s*@", lines[start - 1]):
            start -= 1
        out.append({"short": m.group(1), "start": start + 1, "end": end + 1})
    return out


def _markdown_symbols(lines):
    heads = []
    fence = False
    for i, line in enumerate(lines):
        if re.match(r"\s*(```|~~~)", line):
            fence = not fence
        m = None if fence else re.fullmatch(r"(#{1,6})\s+(.+?)\s*#*\s*", line)
        if m:
            heads.append({"short": m.group(2).strip(), "level": len(m.group(1)), "i": i})
    out = []
    for k, h in enumerate(heads):
        end = len(lines) - 1
        for nxt in heads[k + 1:]:
            if nxt["level"] <= h["level"]:
                end = nxt["i"] - 1
                break
        while end > h["i"] and lines[end].strip() == "":
            end -= 1
        out.append({"name": h["short"], "start": h["i"] + 1, "end": end + 1})
    return out


_PY_DEF = re.compile(r"^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)", A)
_YAML_KEY = re.compile(r"""^\s*(?:-\s+)?["']?([\w.-]+)["']?\s*:(?:\s|$)""", A)
_NO_SINGLE_QUOTE_STRINGS = re.compile(r"\.(rs|c|h|cc|cpp|hpp|cxx|java|kt|kts|scala|swift|cs|go|dart)$", re.I)


def list_symbols(path, lines):
    """All symbols in a file, with qualified names derived from nesting: [{"name", "start", "end"}]."""
    lang = language_of(path)
    if lang == "markdown":
        return _markdown_symbols(lines)
    if lang == "python":
        flat = _indent_symbols(lines, _PY_DEF, True)
    elif lang == "yaml":
        flat = _indent_symbols(lines, _YAML_KEY, False)
    else:
        flat = _brace_symbols(lines, lang == "json", not _NO_SINGLE_QUOTE_STRINGS.search(path))
    ordered = sorted(flat, key=lambda s: (s["start"], -s["end"]))
    stack = []
    out = []
    for s in ordered:
        while stack and not (stack[-1]["start"] <= s["start"] and s["end"] <= stack[-1]["end"] and stack[-1]["start"] != s["start"]):
            stack.pop()
        name = stack[-1]["name"] + "." + s["short"] if stack else s["short"]
        out.append({"name": name, "start": s["start"], "end": s["end"]})
        stack.append({"name": name, "start": s["start"], "end": s["end"]})
    return out


def find_symbol(path, lines, symbol):
    """Find a symbol by qualified name; a unique unqualified match is accepted too."""
    all_symbols = list_symbols(path, lines)
    exact = [s for s in all_symbols if s["name"] == symbol]
    if exact:
        return exact[0]
    if language_of(path) == "markdown":
        ci = [s for s in all_symbols if s["name"].lower() == symbol.lower()]
        return ci[0] if len(ci) == 1 else None
    tail = [s for s in all_symbols if s["name"].endswith("." + symbol)]
    return tail[0] if len(tail) == 1 else None


def enclosing_symbol(path, lines, start, end, max_lines=80):
    """Innermost symbol containing a line range, if it is small enough to be a useful anchor."""
    candidates = [s for s in list_symbols(path, lines) if s["start"] <= start and end <= s["end"] and s["end"] - s["start"] < max_lines]
    if not candidates:
        return None
    best = sorted(candidates, key=lambda s: s["end"] - s["start"])[0]
    back = find_symbol(path, lines, best["name"])
    return best if back and back["start"] == best["start"] and back["end"] == best["end"] else None

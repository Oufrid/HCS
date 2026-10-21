"""Parser and serializer for the .hcs text format (see SPEC.md).

Documents are plain dicts with the same shape as the reference implementation's JSON:
{"headers": {}, "meta": {}, "claims": [...], "probes": [...], "certificates": [...]}.
Optional keys (section, symbol, start, end, hash, probe tags) are absent rather than None.
"""

import re

FORMAT_VERSION = "0.3"
MAGIC = "HCS/" + FORMAT_VERSION
SUPPORTED_VERSIONS = ["0.1", "0.2", "0.3"]

# JavaScript's \w and \d are ASCII-only; spell them out so both implementations agree.
_W = "[A-Za-z0-9_]"


class HcsSyntaxError(Exception):
    def __init__(self, line, message):
        super().__init__("line %d: %s" % (line, message))
        self.line = line


def empty_document(title="Untitled"):
    return {"headers": {"title": title, "root": "."}, "meta": {}, "claims": [], "probes": [], "certificates": []}


_ANCHOR_RE = re.compile(
    r'(?:"([^"]+)"|([^\s"]+?))(?:::(?:"([^"]+)"|([^\s"#]+))|:([0-9]+)(?:-([0-9]+))?)?(?:\s+#([0-9a-f]{6,64})(?:/([0-9a-f]{6,64}))?)?'
)


def parse_anchor(raw, line=0):
    m = _ANCHOR_RE.fullmatch(raw.strip())
    if not m:
        raise HcsSyntaxError(line, 'invalid anchor "%s"' % raw.strip())
    anchor = {"path": m.group(1) if m.group(1) is not None else m.group(2)}
    symbol = m.group(3) if m.group(3) is not None else m.group(4)
    if symbol:
        anchor["symbol"] = symbol
    if m.group(5):
        anchor["start"] = int(m.group(5))
        anchor["end"] = int(m.group(6)) if m.group(6) else anchor["start"]
        if anchor["start"] < 1 or anchor["end"] < anchor["start"]:
            raise HcsSyntaxError(line, 'invalid line range in anchor "%s"' % raw.strip())
    if m.group(7):
        anchor["hash"] = m.group(7)
    if m.group(8):
        anchor["deps"] = m.group(8)
    return anchor


def format_anchor(a, with_hash=True):
    s = '"%s"' % a["path"] if re.search(r"\s", a["path"]) else a["path"]
    if "symbol" in a:
        sym = a["symbol"]
        s += '::"%s"' % sym.replace('"', "'") if re.search(r'[\s"#]', sym) else "::" + sym
    elif "start" in a:
        end = a.get("end")
        s += ":%d-%d" % (a["start"], end) if end is not None and end != a["start"] else ":%d" % a["start"]
    if with_hash and a.get("hash"):
        s += " #" + a["hash"] + ("/" + a["deps"] if a.get("deps") else "")
    return s


_KV_RE = re.compile(r'(%s[A-Za-z0-9_.-]*)=("([^"]*)"|\S+)' % _W)


def _parse_key_values(text):
    out = {}
    for m in _KV_RE.finditer(text):
        out[m.group(1)] = m.group(3) if m.group(3) is not None else m.group(2)
    return out


_MAGIC_RE = re.compile(r"HCS/([0-9]+\.[0-9]+)")
_BLOCK_RE = re.compile(r"\[(claims|probes|certificates)\]")
_HEADER_RE = re.compile(r"@([A-Za-z0-9_-]+)\s*(.*)", re.S)
_SCORE_RE = re.compile(r"!score(?:\s+(.*))?", re.S)
_CLAIM_RE = re.compile(r"#([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?\s+(.+)", re.S)
_PROBE_RE = re.compile(r"\?([A-Za-z0-9_.-]+)(?:\[([^\]]*)\])?\s+(.+)", re.S)


def _trim(s):
    return s.strip()


def _tags(raw):
    return [t.strip() for t in raw.split(",") if t.strip()] if raw else []


def parse(text):
    lines = re.sub(r"\r\n?", "\n", text).split("\n")
    doc = {"headers": {}, "meta": {}, "claims": [], "probes": [], "certificates": []}
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    first = lines[i].strip() if i < len(lines) else ""
    magic = _MAGIC_RE.fullmatch(first)
    if not magic or magic.group(1) not in SUPPORTED_VERSIONS:
        if re.match(r"HCS/[0-9]", first):
            raise HcsSyntaxError(
                i + 1, 'unsupported version "%s", this tool reads %s' % (first, ", ".join("HCS/" + v for v in SUPPORTED_VERSIONS))
            )
        raise HcsSyntaxError(i + 1, 'missing "%s" magic line' % MAGIC)

    block = "header"
    section = None
    current = None
    ids = set()
    for i in range(i + 1, len(lines)):
        raw = lines[i]
        n = i + 1
        t = raw.strip()
        if t == "" or t.startswith("//"):
            continue

        bm = _BLOCK_RE.fullmatch(t)
        if bm:
            block = bm.group(1)
            current = None
            section = None
            continue

        if block == "header":
            m = _HEADER_RE.fullmatch(t)
            if not m:
                raise HcsSyntaxError(n, 'expected a header line "@key value", got "%s"' % t)
            if m.group(1) == "meta":
                doc["meta"].update(_parse_key_values(m.group(2)))
            else:
                doc["headers"][m.group(1)] = m.group(2)
            continue

        if block == "certificates":
            m = _SCORE_RE.fullmatch(t)
            if not m:
                raise HcsSyntaxError(n, 'expected "!score key=value ...", got "%s"' % t)
            doc["certificates"].append({"fields": _parse_key_values(m.group(1) or "")})
            continue

        if re.match(r"\s", raw):
            if current is None:
                raise HcsSyntaxError(n, "indented line outside of a claim or probe")
            if t.startswith(">"):
                current["anchors"].append(parse_anchor(t[1:], n))
            elif block == "probes" and t.startswith("="):
                ans = t[1:].strip()
                if ans:
                    current["answer"] = current["answer"] + " " + ans if current["answer"] else ans
            elif block == "probes" and t.startswith("~"):
                current["claims"].extend(x for x in re.split(r"[\s,]+", t[1:].strip()) if x)
            elif t.startswith("|"):
                more = t[1:].strip()
                if not more:
                    continue
                if block == "claims":
                    current["text"] += " " + more
                else:
                    current["question"] += " " + more
            else:
                raise HcsSyntaxError(n, 'unexpected line "%s"' % t)
            continue

        if block == "claims":
            if t.startswith("## "):
                section = t[3:].strip()
                current = None
                continue
            m = _CLAIM_RE.fullmatch(t)
            if not m:
                raise HcsSyntaxError(n, 'expected a claim "#id text", got "%s"' % t)
            if m.group(1) in ids:
                raise HcsSyntaxError(n, 'duplicate id "%s"' % m.group(1))
            ids.add(m.group(1))
            claim = {"id": m.group(1), "text": m.group(3).strip(), "tags": _tags(m.group(2)), "anchors": []}
            if section:
                claim["section"] = section
            doc["claims"].append(claim)
            current = claim
            continue

        m = _PROBE_RE.fullmatch(t)
        if not m:
            raise HcsSyntaxError(n, 'expected a probe "?id question", got "%s"' % t)
        if m.group(1) in ids:
            raise HcsSyntaxError(n, 'duplicate id "%s"' % m.group(1))
        ids.add(m.group(1))
        probe = {"id": m.group(1), "question": m.group(3).strip(), "answer": "", "anchors": [], "claims": []}
        tags = _tags(m.group(2))
        if tags:
            probe["tags"] = tags
        doc["probes"].append(probe)
        current = probe

    for p in doc["probes"]:
        if not p["answer"]:
            raise HcsSyntaxError(0, 'probe "%s" has no "= expected answer" line' % p["id"])
    return doc


def _quote(v):
    safe = v.replace('"', "'")
    return '"%s"' % safe if re.search(r"\s", safe) else safe


_HEADER_ORDER = ["title", "root", "created", "updated", "generator", "source-files", "source-tokens"]


def serialize(doc):
    needs_03 = any(p.get("tags") for p in doc["probes"]) or any(a.get("deps") for i in doc["claims"] + doc["probes"] for a in i["anchors"])
    out = [MAGIC if needs_03 else "HCS/0.2"]
    headers = doc["headers"]
    keys = [k for k in _HEADER_ORDER if k in headers] + [k for k in headers if k not in _HEADER_ORDER]
    for k in keys:
        out.append(re.sub(r"\s+$", "", "@%s %s" % (k, headers[k])))
    if doc["meta"]:
        out.append("@meta " + " ".join("%s=%s" % (k, _quote(v)) for k, v in doc["meta"].items()))

    out += ["", "[claims]"]
    section = None
    for c in doc["claims"]:
        if c.get("section") != section:
            section = c.get("section")
            if section:
                out += ["", "## " + section]
        out.append("#%s%s %s" % (c["id"], "[%s]" % ",".join(c["tags"]) if c["tags"] else "", c["text"]))
        out += ["  > " + format_anchor(a) for a in c["anchors"]]

    if doc["probes"]:
        out += ["", "[probes]"]
        for p in doc["probes"]:
            tags = "[%s]" % ",".join(p["tags"]) if p.get("tags") else ""
            out += ["?%s%s %s" % (p["id"], tags, p["question"]), "  = " + p["answer"]]
            out += ["  > " + format_anchor(a) for a in p["anchors"]]
            if p["claims"]:
                out.append("  ~ " + " ".join(p["claims"]))

    if doc["certificates"]:
        out += ["", "[certificates]"]
        for c in doc["certificates"]:
            out.append("!score " + " ".join("%s=%s" % (k, _quote(v)) for k, v in c["fields"].items()))
    return "\n".join(out) + "\n"

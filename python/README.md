# hcs (Python)

A second, independent implementation of the [HCS format](../SPEC.md), with no dependencies (Python >= 3.9).
It covers the deterministic part of HCS: parse and serialize `.hcs` files, hash anchors, locate symbols,
check claims against their sources, seal anchors, and render the context block. LLM features (compile, score)
stay in the TypeScript CLI.

```python
from hcs import parse, check_document, render_context, SourceCache, root_dir

doc = parse(open("project.hcs").read())
cache = SourceCache(root_dir(doc, "project.hcs"))
for report in check_document(doc, cache):
    print(report["id"], report["status"])
print(render_context(doc))
```

Install with `pip install hcs-format`. Command line (`python -m hcs` or `hcs-py`): `validate`, `check [--strict]`, `seal [--rehash]`,
`render [--budget N]`.

Both implementations must pass the same language-agnostic suite in [`conformance/`](../conformance):

```bash
python -m unittest discover -s python/tests -v
```

Documents are plain dicts and lists, with the same shape as the reference implementation's JSON (optional keys
are absent rather than `None`).

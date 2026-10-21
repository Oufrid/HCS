"""HCS (Holographic Context Standard): a dependency-free Python implementation of the deterministic core.

Parse and serialize .hcs files, hash anchors, locate symbols, check claims against their sources, seal anchors
and render the context block. It passes the same conformance suite as the reference TypeScript CLI.
"""

from .anchors import (
    HASH_LENGTH,
    SourceCache,
    anchor_hash,
    check_anchor,
    check_document,
    current_hash,
    hash_lines,
    hash_symbol_lines,
    hash_text,
    inside_root,
    normalize_lines,
    root_dir,
    seal,
    worst,
)
from .format import FORMAT_VERSION, MAGIC, SUPPORTED_VERSIONS, HcsSyntaxError, format_anchor, parse, parse_anchor, serialize
from .guard import injection_findings, is_high_risk
from .render import DECODER_PROMPT, context_digest, estimate_tokens, hash_for_certificate, importance, render_context, select_claims
from .symbols import enclosing_symbol, find_symbol, language_of, list_symbols

__version__ = "0.3.0"

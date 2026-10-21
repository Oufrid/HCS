"""Signed certificates (port of src/sign.ts): payload, key ids, trusted keys and signature checks."""

import base64
import hashlib
import re

from . import ed25519

PAYLOAD_PREFIX = "hcs-certificate-v1"


def _b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64url_encode(b):
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def raw_public_key(text):
    m = re.fullmatch(r"ed25519:([A-Za-z0-9_-]{43})", text.strip())
    if not m:
        raise ValueError('invalid public key "%s" (expected ed25519:<43 base64url characters>)' % text.strip())
    return _b64url_decode(m.group(1))


def key_id(public_key):
    """First 12 hex characters of the SHA-256 of the raw 32-byte public key."""
    return hashlib.sha256(_b64url_decode(re.sub(r"^ed25519:", "", public_key))).hexdigest()[:12]


def certificate_payload(fields):
    """The signed bytes: a prefix, then every field but `sig`, sorted, as name=value lines (quotes as stored)."""
    lines = ["%s=%s" % (k, fields[k].replace('"', "'")) for k in sorted(fields) if k != "sig"]
    return "\n".join([PAYLOAD_PREFIX] + lines).encode("utf-8")


def sign_certificate(cert, secret):
    """Sign with a raw 32-byte Ed25519 secret key (tests and tools; the CLI signs with node:crypto)."""
    public = "ed25519:" + _b64url_encode(ed25519.public_key(secret))
    cert["fields"].pop("sig", None)
    cert["fields"]["key"] = key_id(public)
    cert["fields"]["sig"] = _b64url_encode(ed25519.sign(secret, certificate_payload(cert["fields"])))
    return public


def parse_trusted_keys(text):
    """`name ed25519:...` lines, `#` comments -> {key id: {"name", "publicKey"}}."""
    out = {}
    for line in re.split(r"\r?\n", text):
        t = re.sub(r"#.*$", "", line).strip()
        if not t:
            continue
        m = re.fullmatch(r"(\S+)\s+(ed25519:\S+)", t)
        if not m:
            raise ValueError('invalid trusted key line "%s" (expected: name ed25519:<key>)' % t)
        raw_public_key(m.group(2))
        out[key_id(m.group(2))] = {"name": m.group(1), "publicKey": m.group(2)}
    return out


def document_keys(doc):
    """Keys declared in the file's `@keys` header: name=ed25519:... separated by spaces."""
    out = {}
    for part in (doc["headers"].get("keys") or "").split():
        m = re.fullmatch(r"([^=\s]+)=(ed25519:\S+)", part)
        if m:
            out[key_id(m.group(2))] = {"name": m.group(1), "publicKey": m.group(2)}
    return out


def check_signature(cert, trusted, declared):
    """{"status": unsigned | trusted | untrusted | invalid | unknown-key, "signer"?: name}, as in the reference."""
    fields = cert["fields"]
    sig, key = fields.get("sig"), fields.get("key")
    if not sig:
        return {"status": "unsigned"}
    known = (key and trusted.get(key)) or (key and declared.get(key))
    if not key or not known:
        return {"status": "unknown-key"}
    try:
        ok = ed25519.verify(raw_public_key(known["publicKey"]), certificate_payload(fields), _b64url_decode(sig))
    except (ValueError, TypeError):
        ok = False
    if not ok:
        return {"status": "invalid", "signer": known["name"]}
    return {"status": "trusted" if key in trusted else "untrusted", "signer": known["name"]}

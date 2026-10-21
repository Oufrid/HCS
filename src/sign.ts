// Signed certificates: an Ed25519 signature (node:crypto, no dependency) over a certificate's fields proves which key
// produced a score and that nobody edited it since. Trust comes from where the public key comes from: a key listed
// in the .hcs file only proves integrity; a key in a trusted keys file (or HCS_TRUSTED_KEYS) proves origin.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Certificate, HcsDocument } from "./format.js";

/** Domain separation: a signature over these bytes cannot be reused for anything but an HCS certificate. */
const PAYLOAD_PREFIX = "hcs-certificate-v1";

/** Public keys are written `ed25519:<base64url of the 32 raw bytes>`. */
export function formatPublicKey(key: KeyObject): string {
  return `ed25519:${key.export({ format: "jwk" }).x}`;
}

export function parsePublicKey(text: string): KeyObject {
  const m = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m) throw new Error(`invalid public key "${text.trim()}" (expected ed25519:<43 base64url characters>)`);
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: m[1] }, format: "jwk" });
}

/** Short, stable key id: first 12 hex characters of the SHA-256 of the raw public key. */
export function keyId(publicKey: string): string {
  const raw = Buffer.from(publicKey.replace(/^ed25519:/, ""), "base64url");
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

export function generateKeys(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: formatPublicKey(publicKey) };
}

export function loadPrivateKey(pem: string): { key: KeyObject; publicKey: string } {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the signing key must be an Ed25519 private key (hcs keygen)");
  return { key, publicKey: formatPublicKey(createPublicKey(key)) };
}

/**
 * The signed bytes: a fixed prefix, then every field except `sig`, sorted by name, as `name=value` lines. Values are
 * taken as the file stores them (double quotes become single quotes when written), so a round trip keeps the signature.
 */
export function certificatePayload(fields: Record<string, string>): Buffer {
  const lines = Object.keys(fields)
    .filter((k) => k !== "sig")
    .sort()
    .map((k) => `${k}=${fields[k].replace(/"/g, "'")}`);
  return Buffer.from([PAYLOAD_PREFIX, ...lines].join("\n"), "utf8");
}

/** Add `key` (the signer's key id) and `sig` to a certificate. */
export function signCertificate(cert: Certificate, privatePem: string): { keyId: string; publicKey: string } {
  const { key, publicKey } = loadPrivateKey(privatePem);
  const id = keyId(publicKey);
  delete cert.fields.sig;
  cert.fields.key = id;
  cert.fields.sig = sign(null, certificatePayload(cert.fields), key).toString("base64url");
  return { keyId: id, publicKey };
}

/** Named public keys from a trusted keys file: one `name ed25519:...` per line, `#` comments. */
export function parseTrustedKeys(text: string): Map<string, { name: string; publicKey: string }> {
  const out = new Map<string, { name: string; publicKey: string }>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/#.*$/, "").trim();
    if (!t) continue;
    const m = /^(\S+)\s+(ed25519:\S+)$/.exec(t);
    if (!m) throw new Error(`invalid trusted key line "${t}" (expected: name ed25519:<key>)`);
    parsePublicKey(m[2]);
    out.set(keyId(m[2]), { name: m[1], publicKey: m[2] });
  }
  return out;
}

/** Trusted keys from `--trusted <file>` and the HCS_TRUSTED_KEYS environment variable (a file path). */
export function loadTrustedKeys(files: (string | undefined)[]): Map<string, { name: string; publicKey: string }> {
  const out = new Map<string, { name: string; publicKey: string }>();
  for (const f of files) {
    if (!f) continue;
    if (!existsSync(f)) throw new Error(`trusted keys file not found: ${f}`);
    for (const [id, k] of parseTrustedKeys(readFileSync(f, "utf8"))) out.set(id, k);
  }
  return out;
}

/** Keys declared in the file's `@keys` header: `name=ed25519:... name2=ed25519:...`. */
export function documentKeys(doc: HcsDocument): Map<string, { name: string; publicKey: string }> {
  const out = new Map<string, { name: string; publicKey: string }>();
  for (const part of (doc.headers.keys ?? "").split(/\s+/).filter(Boolean)) {
    const m = /^([^=\s]+)=(ed25519:\S+)$/.exec(part);
    if (m) out.set(keyId(m[2]), { name: m[1], publicKey: m[2] });
  }
  return out;
}

export type SignatureStatus = "unsigned" | "trusted" | "untrusted" | "invalid" | "unknown-key";

export interface SignatureCheck {
  status: SignatureStatus;
  /** Name of the key that signed it, when known. */
  signer?: string;
}

/**
 * - `trusted`: valid signature by a key from the trusted keys.
 * - `untrusted`: valid signature by a key the file itself declares: the certificate was not edited since that key
 *   signed it, but anyone can add their own key to a file.
 * - `invalid`: the signature does not match the fields (edited after signing) or is malformed.
 * - `unknown-key`: signed by a key found in neither place.
 */
export function checkSignature(cert: Certificate, trusted: Map<string, { name: string; publicKey: string }>, declared: Map<string, { name: string; publicKey: string }>): SignatureCheck {
  const { sig, key } = cert.fields;
  if (!sig) return { status: "unsigned" };
  const known = (key && trusted.get(key)) || (key && declared.get(key));
  if (!key || !known) return { status: "unknown-key" };
  let ok = false;
  try {
    ok = verify(null, certificatePayload(cert.fields), parsePublicKey(known.publicKey), Buffer.from(sig, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return { status: "invalid", signer: known.name };
  return { status: trusted.has(key) ? "trusted" : "untrusted", signer: known.name };
}

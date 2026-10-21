import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, serialize } from "../src/format.js";
import { hashForCertificate } from "../src/score.js";
import { certificatePayload, checkSignature, documentKeys, generateKeys, keyId, parseTrustedKeys, signCertificate } from "../src/sign.js";
import { tempProject } from "./helpers.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

test("sign and verify a certificate; any edit, a wrong key or a forged key fails", () => {
  const alice = generateKeys();
  const mallory = generateKeys();
  const cert: { fields: Record<string, string> } = { fields: { model: "m:x", judge: "j:y", fidelity: "0.500", note: 'has "quotes" and spaces', digest: "abc123abc123", date: "2026-10-21T00:00:00Z" } };
  const { keyId: id } = signCertificate(cert, alice.privatePem);
  assert.equal(id, keyId(alice.publicKey));
  assert.match(cert.fields.sig, /^[A-Za-z0-9_-]{86}$/);
  const trusted = parseTrustedKeys(`# team keys\nalice ${alice.publicKey}\n`);
  assert.deepEqual(checkSignature(cert, trusted, new Map()), { status: "trusted", signer: "alice" });

  // A round trip through the file format keeps the signature valid (quotes become single quotes when written).
  const doc = parse(serialize({ headers: { title: "t", keys: `alice=${alice.publicKey}` }, meta: {}, claims: [], probes: [], certificates: [cert] }));
  assert.equal(checkSignature(doc.certificates[0], trusted, new Map()).status, "trusted");
  assert.deepEqual(checkSignature(doc.certificates[0], new Map(), documentKeys(doc)), { status: "untrusted", signer: "alice" });

  for (const [field, value] of [["fidelity", "0.990"], ["digest", "000000000000"], ["model", "m:better"]] as const) {
    const edited = { fields: { ...cert.fields, [field]: value } };
    assert.equal(checkSignature(edited, trusted, new Map()).status, "invalid", `edited ${field}`);
  }
  const added = { fields: { ...cert.fields, extra: "1" } };
  assert.equal(checkSignature(added, trusted, new Map()).status, "invalid", "an added field is detected");
  assert.equal(checkSignature({ fields: { ...cert.fields, sig: "garbage" } }, trusted, new Map()).status, "invalid");

  // Mallory re-signs an edited certificate with her own key: valid signature, but not by a trusted key.
  const forged = { fields: { ...cert.fields, fidelity: "0.990" } };
  signCertificate(forged, mallory.privatePem);
  assert.equal(checkSignature(forged, trusted, new Map()).status, "unknown-key");
  const malloryDeclared = new Map([[keyId(mallory.publicKey), { name: "alice", publicKey: mallory.publicKey }]]);
  assert.deepEqual(checkSignature(forged, trusted, malloryDeclared), { status: "untrusted", signer: "alice" }, "a key declared in the file is never trusted");
  assert.equal(checkSignature({ fields: { model: "m" } }, trusted, new Map()).status, "unsigned");
  assert.ok(certificatePayload({ b: "2", a: "1", sig: "x" }).toString().startsWith("hcs-certificate-v1\na=1\nb=2"));
  assert.throws(() => parseTrustedKeys("bob ed25519:short"), /invalid public key/);
});

test("CLI: keygen, a signed certificate, check with and without trusted keys, tampering, badge", () => {
  const dir = tempProject({ "a.txt": "fact\n", "project.hcs": "HCS/0.2\n@title t\n[claims]\n#c1 A fact.\n  > a.txt:1\n" });
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(run("seal", "project.hcs").status, 0);
    let r = run("keygen", "team");
    assert.equal(r.status, 0, r.stderr);
    const pub = readFileSync(join(dir, "team.pub"), "utf8").trim();
    writeFileSync(join(dir, "trusted.txt"), `team ${pub}\n`);
    assert.equal(run("keygen", "team").status, 2, "never overwrites a key");

    // A certificate for the current context, signed as `score --write --sign` does.
    const doc = parse(readFileSync(join(dir, "project.hcs"), "utf8"));
    const digest = JSON.parse(run("check", "project.hcs", "--json").stdout).certificates;
    assert.deepEqual(digest, []);
    const cert: { fields: Record<string, string> } = { fields: { model: "m:x", judge: "j:y", fidelity: "0.875", ci95: "0.750-0.950", probes: "24", digest: hashForCertificate(doc, new Map([["c1", "ok"]])), date: "2026-10-21T00:00:00Z" } };
    signCertificate(cert, readFileSync(join(dir, "team.key"), "utf8"));
    doc.certificates.push(cert);
    doc.headers.keys = `team=${pub}`;
    writeFileSync(join(dir, "project.hcs"), serialize(doc));

    r = run("check", "project.hcs");
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /current, signed by team \(key declared in this file, not in your trusted keys/);
    r = run("check", "project.hcs", "--trusted", "trusted.txt");
    assert.match(r.stdout, /current, signed by trusted key team/);
    r = run("badge", "project.hcs", "--trusted", "trusted.txt", "-o", "badge.svg");
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, "badge.svg"), "utf8"), /<svg[\s\S]*HCS fidelity[\s\S]*87\.5% \[75-95\] · m:x/);
    assert.equal(run("badge", "project.hcs").status, 2, "no badge without trusted keys");

    // Someone raises the score in the file: check fails, and no badge is drawn.
    writeFileSync(join(dir, "project.hcs"), readFileSync(join(dir, "project.hcs"), "utf8").replace("fidelity=0.875", "fidelity=0.990"));
    r = run("check", "project.hcs", "--trusted", "trusted.txt");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SIGNATURE INVALID[\s\S]*FAIL: 1 signed certificate\(s\) were edited after signing/);
    assert.equal(run("badge", "project.hcs", "--trusted", "trusted.txt").status, 1);

    // An outdated certificate (the source changed) is not badge material either, even if correctly signed.
    writeFileSync(join(dir, "project.hcs"), serialize(doc));
    writeFileSync(join(dir, "a.txt"), "changed\n");
    assert.equal(run("seal", "project.hcs", "--rehash").status, 0);
    assert.equal(run("badge", "project.hcs", "--trusted", "trusted.txt").status, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

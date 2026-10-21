import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HcsSyntaxError, parse, serialize } from "../src/format.js";

/** Deterministic PRNG so a failure can be replayed from its seed. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = [
  readFileSync(new URL("../../project.hcs", import.meta.url), "utf8"),
  'HCS/0.3\n@title "a b"\n@meta k=v x="y z"\n\n[claims]\n## S\n#c1[manual,suspect] text\n  | more\n  > "a b.ts"::"My Sym" #abcdef123456\n  > x.py:3-9\n\n[probes]\n?p1[known] q\n  | more\n  = a\n  = b\n  > x.py\n  ~ c1\n\n[certificates]\n!score model=m fidelity=0.5 date=2026\n',
];

/** Fragments that exercise the grammar: markers, brackets, anchors, numbers, quotes, unicode, control chars. */
const TOKENS = ["HCS/0.2", "HCS/9.9", "[claims]", "[probes]", "[certificates]", "#", "?", "!score", "@", "> ", "  ", "=", "~", "|", "::", ":", "-", "#ffffff", "0", "999999999999999999999", "\"", "[", "]", ",", "\n", "\r\n", "\t", "\u0000", "é", "😀", "‮", "a".repeat(300)];

function mutate(text: string, rand: () => number): string {
  let s = text;
  const ops = 1 + Math.floor(rand() * 8);
  for (let i = 0; i < ops; i++) {
    const pos = Math.floor(rand() * (s.length + 1));
    const op = Math.floor(rand() * 5);
    if (op === 0) s = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(rand() * 20)); // delete
    else if (op === 1) s = s.slice(0, pos) + TOKENS[Math.floor(rand() * TOKENS.length)] + s.slice(pos); // insert token
    else if (op === 2) s = s.slice(0, pos) + String.fromCharCode(Math.floor(rand() * 0x3000)) + s.slice(pos + 1); // replace char
    else if (op === 3) {
      const lines = s.split("\n"); // duplicate or swap lines
      const a = Math.floor(rand() * lines.length);
      const b = Math.floor(rand() * lines.length);
      [lines[a], lines[b]] = [lines[b], lines[a]];
      if (rand() < 0.5) lines.splice(a, 0, lines[b]);
      s = lines.join("\n");
    } else s = s.slice(0, pos); // truncate
  }
  return s;
}

function randomText(rand: () => number): string {
  let s = rand() < 0.7 ? "HCS/0.3\n" : "";
  const n = Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(rand() * TOKENS.length)] + (rand() < 0.3 ? "\n" : "");
  return s;
}

/** Parsing must either succeed (and then round-trip) or throw HcsSyntaxError: never crash with anything else. */
function assertWellBehaved(input: string, label: string): void {
  let doc;
  try {
    doc = parse(input);
  } catch (e) {
    if (e instanceof HcsSyntaxError) return;
    assert.fail(`${label}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\ninput: ${JSON.stringify(input.slice(0, 400))}`);
  }
  let again;
  try {
    again = parse(serialize(doc));
  } catch (e) {
    assert.fail(`${label}: serialized output does not parse: ${e instanceof Error ? e.message : e}\ninput: ${JSON.stringify(input.slice(0, 400))}`);
  }
  assert.equal(serialize(again), serialize(doc), `${label}: serialization is not stable\ninput: ${JSON.stringify(input.slice(0, 400))}`);
}

test("parser fuzz: mutated real files never crash", () => {
  const rand = rng(1);
  for (let i = 0; i < 3000; i++) assertWellBehaved(mutate(SEEDS[i % SEEDS.length], rand), `mutation #${i}`);
});

test("parser fuzz: random token soup never crashes", () => {
  const rand = rng(2);
  for (let i = 0; i < 3000; i++) assertWellBehaved(randomText(rand), `random #${i}`);
});

test("regressions found by fuzzing", () => {
  // An empty certificate serialized as "!score" and could not be read back.
  assert.equal(parse(serialize(parse("HCS/0.2\n[certificates]\n!score\n"))).certificates.length, 1);
  // Empty "=" and "|" continuation lines added trailing spaces that changed on the next round trip.
  const doc = parse("HCS/0.2\n[claims]\n#c1 text\n  |\n[probes]\n?p1 q\n  = a\n  =\n");
  assert.equal(doc.claims[0].text, "text");
  assert.equal(doc.probes[0].answer, "a");
  // A double quote inside an unquoted value made the serialized form change on every round trip.
  const once = serialize(parse('HCS/0.2\n@meta k=v"x\n'));
  assert.equal(serialize(parse(once)), once);
});

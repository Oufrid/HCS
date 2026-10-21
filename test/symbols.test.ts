import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { checkAnchor, normalizeLines, seal, SourceCache } from "../src/anchors.js";
import { formatAnchor, parse, parseAnchor } from "../src/format.js";
import { findSymbol, listSymbols } from "../src/symbols.js";
import { tempProject } from "./helpers.js";

const names = (path: string, src: string) => listSymbols(path, normalizeLines(src)).map((s) => `${s.name}:${s.start}-${s.end}`);

test("symbols: TypeScript / JavaScript", () => {
  const src = [
    'import { type Foo } from "./foo";',
    "export const LIMIT = 30;",
    "export class Cart {",
    "  private items: Item[] = [];",
    "  add(item: Item): void {",
    "    this.items.push(item);",
    "    log(`added ${item} {`);",
    "  }",
    "  static async total(): Promise<number> {",
    "    return sum(1, 2);",
    "  }",
    "}",
    "export async function checkout(cart: Cart) {",
    "  const fee = compute(cart);",
    "  test(\"x\", () => {",
    "  });",
    "  return fee;",
    "}",
    "const handler = async (req) => {",
    "  await run(req);",
    "};",
  ].join("\n");
  assert.deepEqual(names("a.ts", src), ["LIMIT:2-2", "Cart:3-12", "Cart.add:5-8", "Cart.total:9-11", "checkout:13-18", "handler:19-21"]);
  assert.equal(findSymbol("a.ts", normalizeLines(src), "add")!.start, 5, "unique short name resolves");
});

test("symbols: Python, Go, Rust, Java, Markdown, YAML, JSON", () => {
  assert.deepEqual(
    names("a.py", "import os\n\n@cache\ndef top(a):\n    return a\n\nclass Shop:\n    rate = 4\n\n    def fee(self, w):\n        return w\n\nx = 1\n"),
    ["top:3-5", "Shop:7-11", "Shop.fee:10-11"],
  );
  assert.deepEqual(
    names("a.go", "package main\n\ntype Server struct {\n\taddr string\n}\n\nfunc (s *Server) Start(port int) error {\n\treturn listen(s.addr)\n}\n"),
    ["Server:3-5", "Start:7-9"],
  );
  assert.deepEqual(
    names("a.rs", "pub struct Point<'a> {\n    x: &'a str,\n}\n\nimpl Point<'_> {\n    pub fn norm(&self) -> f64 {\n        0.0\n    }\n}\n"),
    ["Point:1-3", "Point:5-9", "Point.norm:6-8"],
  );
  assert.deepEqual(
    names("A.java", "public class A {\n    public static int twice(int x) {\n        return helper(x) * 2;\n    }\n}\n"),
    ["A:1-5", "A.twice:2-4"],
  );
  assert.deepEqual(
    names("a.md", "# Title\n\nintro\n\n## Setup\n\nrun it\n\n```\n# not a heading\n```\n\n## Usage\n\nuse it\n"),
    ["Title:1-15", "Setup:5-11", "Usage:13-15"],
  );
  assert.deepEqual(names("c.yaml", "server:\n  port: 8080\n  host: x\nlog: info\n"), ["server:1-3", "server.port:2-2", "server.host:3-3", "log:4-4"]);
  assert.deepEqual(names("c.json", '{\n  "a": {\n    "b": [\n      1\n    ]\n  },\n  "c": 2\n}\n'), ["a:2-6", "a.b:3-5", "c:7-7"]);
});

test("symbols: regex literals, multi-line signatures and calls are handled", () => {
  const src = [
    "function quote(v: string): string {",
    '  return /[\\s"{]/.test(v) ? `"${v}"` : v;',
    "}",
    "function build(",
    "  id: string,",
    "  extra: Record<string, string> = {},",
    "): Client {",
    "  return { id, async complete(req) { return req; } };",
    "}",
    'register("openai", (m) =>',
    "  build(m, {}),",
    ");",
    "const PATTERNS: { re: RegExp }[] = [",
    "  { re: /a{2}/ },",
    "];",
    "const ratio = total /",
    "  count;",
  ].join("\n");
  assert.deepEqual(names("x.ts", src), ["quote:1-3", "build:4-9", "PATTERNS:13-15", "ratio:16-17"]);
});

test("symbol anchor syntax", () => {
  assert.deepEqual(parseAnchor("src/a.ts::Cart.add #abcdef123456"), { path: "src/a.ts", symbol: "Cart.add", hash: "abcdef123456" });
  assert.deepEqual(parseAnchor('docs/x.md::"Refund policy"'), { path: "docs/x.md", symbol: "Refund policy" });
  assert.equal(formatAnchor({ path: "docs/x.md", symbol: "Refund policy", hash: "abcdef" }), 'docs/x.md::"Refund policy" #abcdef');
  assert.deepEqual(parseAnchor("src/a.ts:3-4"), { path: "src/a.ts", start: 3, end: 4 });
  assert.equal(parse("HCS/0.1\n[claims]\n#a x\n  > f.ts::g\n").claims[0].anchors[0].symbol, "g", "0.1 files still read");
});

test("symbol anchors survive reformatting and moves, detect real changes", () => {
  const original = "export function fee(w: number) {\n  return 25 + w * 4;\n}\n";
  const dir = tempProject({ "src/rates.ts": original, "src/other.ts": "export const X = 1;\n" });
  const doc = parse("HCS/0.2\n[claims]\n#c1 Fee is 25 plus 4 per kg.\n  > src/rates.ts::fee\n");
  const a = doc.claims[0].anchors[0];
  const check = () => checkAnchor(a, new SourceCache(dir));
  assert.equal(check().status, "unsealed");
  seal(doc, new SourceCache(dir));
  assert.equal(check().status, "ok");

  // Reformatted and pushed down by new code: still ok.
  writeFileSync(join(dir, "src/rates.ts"), "// header\nexport const Y = 2;\n\nexport function fee(w: number)\n{\n    return 25 + w*4;\n}\n");
  assert.equal(check().status, "ok");

  // Moved to another file unchanged: moved, and seal follows it.
  writeFileSync(join(dir, "src/rates.ts"), "export const Y = 2;\n");
  mkdirSync(join(dir, "src/pricing"), { recursive: true });
  writeFileSync(join(dir, "src/pricing/fees.ts"), "import x from 'y';\n\n" + original);
  const r = check();
  assert.equal(r.status, "moved");
  assert.deepEqual(r.relocated, { path: "src/pricing/fees.ts", symbol: "fee" });
  assert.equal(seal(doc, new SourceCache(dir)).relocated, 1);
  assert.equal(a.path, "src/pricing/fees.ts");
  assert.equal(check().status, "ok");

  // Logic change: stale.
  writeFileSync(join(dir, "src/pricing/fees.ts"), original.replace("* 4", "* 5"));
  assert.equal(check().status, "stale");

  // Deleted everywhere: missing.
  writeFileSync(join(dir, "src/pricing/fees.ts"), "export {};\n");
  assert.equal(check().status, "missing");
  rmSync(dir, { recursive: true });
});

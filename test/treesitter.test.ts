import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSymbol, listSymbols, setSymbolBackend, symbolBackend } from "../src/symbols.js";
import { enableTreeSitter } from "../src/treesitter.js";
import { tempProject } from "./helpers.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

const TS = `import { x } from "./x";

export const LABELS = { ok: "ok", bad: "bad" };
const handlers = { get: (k: string) => k, put: (k: string) => k };

export class Cart {
  @observable items: string[] = [];
  onChange = () => {
    return 1;
  };
  add(item: string): void {
    const local = item;
    this.items.push(local);
  }
}

export interface Store {
  load(id: string): Promise<string>;
}

const help = \`
function notASymbol() {
}
\`;
`;

const PY = `import os

TEMPLATE = """
def not_a_symbol():
    pass
"""

@dataclass
class Cart:
    items: list

    @property
    def size(self):
        return len(self.items)


def helper():
    def inner():
        return 1
    return inner()
`;

const lines = (s: string) => s.replace(/\n$/, "").split("\n");
const names = (path: string, text: string) => listSymbols(path, lines(text)).map((s) => `${s.name} ${s.start}-${s.end}`);

test("tree-sitter back-end: qualified symbols for TypeScript and Python, heuristic otherwise and by default", async () => {
  assert.equal(symbolBackend(), "heuristic");
  const heuristic = names("a.ts", TS);
  assert.deepEqual(await enableTreeSitter(), ["typescript", "tsx", "javascript", "python"]);
  assert.equal(symbolBackend(), "tree-sitter");
  try {
    assert.deepEqual(names("a.ts", TS), [
      "LABELS 3-3",
      "handlers 4-4",
      "handlers.get 4-4",
      "handlers.put 4-4",
      "Cart 6-15",
      "Cart.onChange 8-10",
      "Cart.add 11-14",
      "Store 17-19",
      "Store.load 18-18",
      "help 21-24",
    ]);
    // The heuristic misses functions in one-line objects and class fields holding a function.
    assert.ok(!heuristic.some((s) => /^(handlers\.|Cart\.onChange)/.test(s)), heuristic.join("\n"));
    // Same names and ranges where both see a multi-line definition.
    for (const s of ["Cart 6-15", "Cart.add 11-14", "Store 17-19"]) assert.ok(heuristic.includes(s), s);

    // Python: decorators belong to the definition, code inside strings is not a symbol.
    assert.deepEqual(names("a.py", PY), ["Cart 8-14", "Cart.size 12-14", "helper 17-20", "helper.inner 18-19"]);
    assert.deepEqual(findSymbol("a.py", lines(PY), "size"), { name: "Cart.size", start: 12, end: 14 });

    // Other languages keep the heuristic.
    assert.deepEqual(names("a.go", "func Run() {\n}\n"), ["Run 1-2"]);
  } finally {
    setSymbolBackend(undefined);
  }
  assert.equal(symbolBackend(), "heuristic");
  assert.deepEqual(names("a.ts", TS), heuristic, "turning it off restores the default exactly");
});

const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("CLI: a file sealed with --parser tree-sitter records it, and later commands use it", () => {
  const dir = tempProject({ "src/cart.py": PY });
  const file = join(dir, "ctx.hcs");
  writeFileSync(file, "HCS/0.2\n@title T\n[claims]\n#c1 Size counts items.\n  > src/cart.py::Cart.size\n");
  try {
    let r = run(["seal", file, "--parser", "tree-sitter"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(file, "utf8"), /^HCS\/0.3\n[\s\S]*^@parser tree-sitter$/m);

    r = run(["check", file, "--strict"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // Without the optional packages, a file that needs them fails clearly instead of reading as stale.
    const empty = mkdtempSync(join(tmpdir(), "hcs-no-grammars-"));
    r = run(["check", file], { HCS_TREE_SITTER_GRAMMARS: empty });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /sealed with the tree-sitter symbol parser/);
    rmSync(empty, { recursive: true });

    r = run(["check", file, "--parser", "nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown parser "nope"/);

    // The heuristic seal of the same file writes no header.
    writeFileSync(file, "HCS/0.2\n@title T\n[claims]\n#c1 Size counts items.\n  > src/cart.py::Cart.size\n");
    assert.equal(run(["seal", file]).status, 0);
    assert.doesNotMatch(readFileSync(file, "utf8"), /@parser/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

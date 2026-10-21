// Optional tree-sitter back-end for the symbol locator (`--parser tree-sitter`, or HCS_PARSER=tree-sitter).
// It is never a hard dependency: `web-tree-sitter` and the grammar packages are loaded at run time only when
// asked for, and files in other languages keep the heuristic of src/symbols.ts. Hashes of `path::Symbol`
// anchors depend on the symbol's range, so a file must be checked with the parser it was sealed with: the
// writer records `@parser tree-sitter` and the CLI turns the back-end on for such files.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setSymbolBackend } from "./symbols.js";

/** Grammar name and the npm package that ships its `.wasm`, by file extension. */
const GRAMMARS: Record<string, { grammar: string; pkg: string }> = {
  ts: { grammar: "typescript", pkg: "tree-sitter-typescript" },
  mts: { grammar: "typescript", pkg: "tree-sitter-typescript" },
  cts: { grammar: "typescript", pkg: "tree-sitter-typescript" },
  tsx: { grammar: "tsx", pkg: "tree-sitter-typescript" },
  js: { grammar: "javascript", pkg: "tree-sitter-javascript" },
  mjs: { grammar: "javascript", pkg: "tree-sitter-javascript" },
  cjs: { grammar: "javascript", pkg: "tree-sitter-javascript" },
  jsx: { grammar: "javascript", pkg: "tree-sitter-javascript" },
  py: { grammar: "python", pkg: "tree-sitter-python" },
  pyi: { grammar: "python", pkg: "tree-sitter-python" },
};

export const INSTALL_HINT = "npm install web-tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python";

/** Minimal shape of the web-tree-sitter API used here (so this file compiles without its types). */
interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TSNode | null;
  namedChildren: (TSNode | null)[];
  childForFieldName(name: string): TSNode | null;
}

type Sym = { name: string; start: number; end: number };

/** Declarations that name a symbol through their `name` field, as in the heuristic's keyword patterns. */
const NAMED = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "internal_module",
  "module",
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  // Python
  "function_definition",
  "class_definition",
]);

const FUNCTION_VALUES = new Set(["function_expression", "function", "arrow_function", "generator_function"]);

/** 1-based inclusive line range of a node; a node ending at column 0 ends on the line before. */
function range(n: TSNode): { start: number; end: number } {
  const end = n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row ? n.endPosition.row - 1 : n.endPosition.row;
  return { start: n.startPosition.row + 1, end: end + 1 };
}

/** The statement a declaration stands for: `export ...` and Python decorators belong to it. */
function outer(n: TSNode): TSNode {
  const p = n.parent;
  return p && (p.type === "export_statement" || p.type === "decorated_definition") ? p : n;
}

/** The symbol names a node declares (several for `const a = 1, b = 2`), with the same rules as the heuristic. */
function declared(n: TSNode): { short: string; node: TSNode }[] {
  if (NAMED.has(n.type)) {
    const name = n.childForFieldName("name");
    return name ? [{ short: name.text, node: outer(n) }] : [];
  }
  if ((n.type === "lexical_declaration" || n.type === "variable_declaration") && outer(n).parent?.type === "program") {
    // Only top-level constants and variables: locals are not useful anchors.
    return n.namedChildren.flatMap((d) => {
      const name = d?.type === "variable_declarator" ? d.childForFieldName("name") : null;
      return name?.type === "identifier" ? [{ short: name.text, node: outer(n) }] : [];
    });
  }
  // Object members and class fields holding a function: `capture: async (x) => {...}`, `handle = () => {...}`.
  const key = n.type === "pair" ? n.childForFieldName("key") : n.type === "public_field_definition" || n.type === "field_definition" ? (n.childForFieldName("name") ?? n.childForFieldName("property")) : null;
  const value = key && n.childForFieldName("value");
  return key && value && FUNCTION_VALUES.has(value.type) && /^[A-Za-z_$][\w$]*$/.test(key.text) ? [{ short: key.text, node: n }] : [];
}

/** Symbols of one syntax tree, qualified by the tree's own nesting (one-line objects included). */
export function treeSymbols(root: TSNode): Sym[] {
  const out: Sym[] = [];
  const visit = (n: TSNode, prefix: string) => {
    const own = declared(n);
    for (const d of own) out.push({ name: prefix + d.short, ...range(d.node) });
    // Members of a single declaration are qualified by it (`Cart.add`); with several names, by none.
    const inner = own.length === 1 ? `${prefix}${own[0].short}.` : prefix;
    for (const c of n.namedChildren) if (c) visit(c, inner);
  };
  visit(root, "");
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

function grammarFile(grammar: string, pkg: string): string | undefined {
  const dir = process.env.HCS_TREE_SITTER_GRAMMARS;
  if (dir) {
    const f = resolve(dir, `tree-sitter-${grammar}.wasm`);
    return existsSync(f) ? f : undefined;
  }
  // Look next to hcs itself, then in the current project (hcs installed globally, grammars in the project).
  for (const base of [import.meta.url, join(process.cwd(), "noop.js")]) {
    try {
      const f = join(createRequire(base).resolve(`${pkg}/package.json`), "..", `tree-sitter-${grammar}.wasm`);
      if (existsSync(f)) return f;
    } catch {
      // not installed there
    }
  }
  return undefined;
}

async function importParser(): Promise<any> {
  const name = "web-tree-sitter";
  try {
    return await import(name);
  } catch {
    // Not next to hcs: try the current project.
    const path = createRequire(join(process.cwd(), "noop.js")).resolve(name);
    return await import(new URL(`file://${path}`).href);
  }
}

/**
 * Load web-tree-sitter and the grammars it can find, then route TypeScript, JavaScript and Python files through
 * it. Throws with an install hint when web-tree-sitter or every grammar is missing. Returns the grammars loaded.
 */
export async function enableTreeSitter(): Promise<string[]> {
  let mod: any;
  try {
    mod = await importParser();
  } catch {
    throw new Error(`--parser tree-sitter needs the optional packages, not installed here: ${INSTALL_HINT}`);
  }
  const { Parser, Language } = mod;
  await Parser.init();
  const parsers = new Map<string, any>();
  for (const { grammar, pkg } of Object.values(GRAMMARS)) {
    if (parsers.has(grammar)) continue;
    const file = grammarFile(grammar, pkg);
    if (!file) continue;
    const parser = new Parser();
    parser.setLanguage(await Language.load(file));
    parsers.set(grammar, parser);
  }
  if (!parsers.size) throw new Error(`--parser tree-sitter found no grammar (.wasm); install them: ${INSTALL_HINT}`);
  // listSymbols is called once per anchor; parse each distinct file content once.
  const cache = new Map<string, Sym[]>();
  setSymbolBackend((path, lines) => {
    const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
    const parser = GRAMMARS[ext] && parsers.get(GRAMMARS[ext].grammar);
    if (!parser) return null;
    const text = lines.join("\n");
    const key = `${ext}\0${text}`;
    let symbols = cache.get(key);
    if (!symbols) {
      const tree = parser.parse(text);
      symbols = tree ? treeSymbols(tree.rootNode) : [];
      tree?.delete();
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
      cache.set(key, symbols);
    }
    return symbols.map((s) => ({ ...s }));
  }, "tree-sitter");
  return [...parsers.keys()];
}

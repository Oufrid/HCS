// Lightweight, dependency-free symbol locator used by `path::Symbol` anchors.
// It is heuristic (no full parser) but covers the common shapes of brace languages, Python, Markdown,
// YAML and JSON. Unknown symbols are reported as missing, never guessed.

export interface SymbolRange {
  /** Qualified name, members joined with "." (e.g. "PaymentService.capture"). */
  name: string;
  /** 1-based inclusive. */
  start: number;
  end: number;
}

type Lang = "brace" | "python" | "markdown" | "yaml" | "json";

type Flat = Omit<SymbolRange, "name"> & { short: string };

export function languageOf(path: string): Lang {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  if (["py", "pyi"].includes(ext)) return "python";
  if (["md", "mdx", "markdown"].includes(ext)) return "markdown";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["json", "jsonc"].includes(ext)) return "json";
  return "brace";
}

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do", "try", "with", "await", "new", "throw", "typeof", "sizeof", "elif", "except", "using", "lock", "foreach", "match", "when", "select", "defer", "go"]);

/** Lines that start with these words declare nothing (imports, statements). */
const NOT_A_DEFINITION = /^\s*(?:import|from|use|using|package|require|include|#\s*include|return|throw|await|yield|new|delete|goto|break|continue|case)\b|^\s*export\s*\{|^\s*export\s+\*/;

const BRACE_DEFS: RegExp[] = [
  // function foo, class Foo, interface Foo, enum, struct, trait, fn, func (incl. Go receivers), type, namespace...
  /\b(?:function\*?|class|interface|enum|struct|trait|impl|fn|func|def|type|namespace|module|object|record|union|protocol|extension)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  // const foo = ..., let/var/val
  /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var|val|static)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/,
  // object members: foo: function, foo: (..) =>, foo(...) {   and class methods with modifiers / return types
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|export|default|final|virtual|internal|suspend|open|inline|get|set|unsafe|pub(?:\([^)]*\))?|const|extern)\s+)*(?:[\w<>[\],.?*&:]+\s+)*?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
];

interface ScanState {
  comment: boolean;
  /** Inside a multi-line template literal (backticks). */
  template: boolean;
  /** Whether '...' delimits strings (JS, PHP...) or only char literals (Rust, C, Java...). */
  singleQuoteStrings: boolean;
}

const newState = (singleQuoteStrings = true): ScanState => ({ comment: false, template: false, singleQuoteStrings });

/** Characters after which a `/` starts a regular expression literal rather than a division. */
const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** Strip string literals, regex literals and comments so braces and words inside them do not count. */
function codeOnly(line: string, st: ScanState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (st.comment) {
      const end = line.indexOf("*/", i);
      if (end === -1) return out;
      st.comment = false;
      i = end + 2;
      continue;
    }
    if (st.template) {
      const end = findClose(line, i - 1, "`");
      if (end === -1) return out;
      st.template = false;
      out += " ";
      i = end + 1;
      continue;
    }
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "#" && /^#\s/.test(line.slice(i)) && out.trim() === "") break; // shell/py-style comment line
    if (ch === "/" && line[i + 1] === "*") {
      st.comment = true;
      i += 2;
      continue;
    }
    if (ch === "/") {
      const prev = out.trimEnd();
      if (REGEX_PRECEDERS.has(prev.slice(-1)) || /\b(return|typeof|case)$/.test(prev)) {
        const close = regexClose(line, i);
        if (close !== -1) {
          out += " ";
          i = close + 1;
          while (i < line.length && /[a-z]/i.test(line[i])) i++;
          continue;
        }
      }
    }
    if (ch === '"' || ch === "`" || (ch === "'" && st.singleQuoteStrings)) {
      const close = findClose(line, i, ch);
      if (close !== -1) {
        out += " ";
        i = close + 1;
        continue;
      }
      if (ch === "`") {
        st.template = true;
        return out;
      }
    }
    if (ch === "'" && !st.singleQuoteStrings) {
      // Char literal ('a', '\n', '\u{1F600}'); otherwise a lifetime or label: leave it.
      const m = /^'(\\.[^']{0,8}|[^'\\])'/.exec(line.slice(i));
      if (m) {
        out += " ";
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function findClose(line: string, from: number, q: string): number {
  for (let j = from + 1; j < line.length; j++) {
    if (line[j] === "\\") j++;
    else if (line[j] === q) return j;
  }
  return -1;
}

function regexClose(line: string, from: number): number {
  let inClass = false;
  for (let j = from + 1; j < line.length; j++) {
    const c = line[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j > from + 1 ? j : -1;
  }
  return -1;
}

/**
 * "block": a definition with a body; braces count only outside the parameter list, and a body must open.
 * "value": an initializer (const x = ...); all brackets count, and it ends at the statement's end.
 * "json": a JSON value.
 */
type EndMode = "block" | "value" | "json";

function findEnd(lines: string[], startIdx: number, mode: EndMode, singleQuoteStrings: boolean): { end: number; opened: boolean } {
  let depth = 0;
  let parens = 0;
  let opened = false;
  const st = newState(singleQuoteStrings);
  const opens = mode === "block" ? "{" : "{[(";
  const closes = mode === "block" ? "}" : "}])";
  for (let i = startIdx; i < lines.length && i < startIdx + 2000; i++) {
    const code = codeOnly(lines[i], st);
    for (const ch of code) {
      if (mode === "block" && ch === "(") parens++;
      else if (mode === "block" && ch === ")") parens = Math.max(0, parens - 1);
      else if (opens.includes(ch) && parens === 0) {
        depth++;
        opened = true;
      } else if (closes.includes(ch) && parens === 0) depth--;
      else if (ch === ";" && depth <= 0 && parens === 0) return { end: i, opened };
    }
    // An initializer whose line ends with an operator continues on the next line.
    const continues = mode === "value" && /(=>|[=,(+\-*?:]|&&|\|\|)\s*$/.test(code);
    if (opened && depth <= 0 && !continues) return { end: i, opened };
    if (mode === "json" && !opened && i === startIdx) return { end: i, opened };
    if (!opened && i > startIdx + 8) return { end: startIdx, opened };
  }
  return { end: opened ? Math.min(lines.length - 1, startIdx + 1999) : startIdx, opened };
}

function braceSymbols(lines: string[], json: boolean, singleQuoteStrings: boolean): Flat[] {
  const out: Flat[] = [];
  const st = newState(singleQuoteStrings);
  for (let i = 0; i < lines.length; i++) {
    const wasInside = st.comment || st.template;
    const code = codeOnly(lines[i], st);
    if (wasInside || !code.trim()) continue;
    let name: string | undefined;
    let kind = -1;
    if (json) {
      name = /^\s*"([^"]+)"\s*:/.exec(lines[i])?.[1];
    } else {
      if (NOT_A_DEFINITION.test(code)) continue;
      const nested = /^\s/.test(code);
      BRACE_DEFS.some((re, k) => {
        const m = re.exec(code);
        if (!m || CONTROL.has(m[1])) return false;
        // Local variables are not useful anchors; only top-level const/let/var count.
        if (k === 1 && nested) return false;
        // A call taking a callback (`test("x", () => {`) is not a definition.
        if (k === 2 && /=>|\bfunction\b|,\s*$/.test(code.slice(m.index + m[0].length))) return false;
        name = m[1];
        kind = k;
        return true;
      });
    }
    if (!name) continue;
    const mode: EndMode = json ? "json" : kind === 1 ? "value" : "block";
    const { end, opened } = findEnd(lines, i, mode, singleQuoteStrings);
    // A method-like line without a body is a call, unless it is a typed signature (`foo(): T;`).
    if (kind === 2 && !opened && !/\)\s*:[^;]*;\s*$/.test(code)) continue;
    out.push({ short: name, start: i + 1, end: end + 1 });
  }
  return out;
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;
}

function indentSymbols(lines: string[], re: RegExp, includeDecorators: boolean): Flat[] {
  const out: Flat[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const ind = indentOf(lines[i]);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= ind) break;
      end = j;
    }
    let start = i;
    while (includeDecorators && start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    out.push({ short: m[1], start: start + 1, end: end + 1 });
  }
  return out;
}

function markdownSymbols(lines: string[]): (Flat & { level: number })[] {
  const heads: { short: string; level: number; i: number }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ short: m[2].trim(), level: m[1].length, i });
  });
  return heads.map((h, k) => {
    let end = lines.length - 1;
    for (const n of heads.slice(k + 1)) {
      if (n.level <= h.level) {
        end = n.i - 1;
        break;
      }
    }
    while (end > h.i && lines[end].trim() === "") end--;
    return { short: h.short, level: h.level, start: h.i + 1, end: end + 1 };
  });
}

/** All symbols in a file with qualified names derived from nesting. */
export function listSymbols(path: string, lines: string[]): SymbolRange[] {
  const lang = languageOf(path);
  let flat: Flat[];
  if (lang === "markdown") {
    // Headings are addressed by their own text; nesting would make names fragile.
    return markdownSymbols(lines).map((s) => ({ name: s.short, start: s.start, end: s.end }));
  } else if (lang === "python") flat = indentSymbols(lines, /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/, true);
  else if (lang === "yaml") flat = indentSymbols(lines, /^\s*(?:-\s+)?["']?([\w.-]+)["']?\s*:(?:\s|$)/, false);
  else flat = braceSymbols(lines, lang === "json", !/\.(rs|c|h|cc|cpp|hpp|cxx|java|kt|kts|scala|swift|cs|go|dart)$/i.test(path));

  // Qualify by containment: the innermost strictly enclosing symbol is the parent.
  const sorted = [...flat].sort((a, b) => a.start - b.start || b.end - a.end);
  const stack: (Flat & { name: string })[] = [];
  const out: SymbolRange[] = [];
  for (const s of sorted) {
    while (stack.length && !(stack[stack.length - 1].start <= s.start && s.end <= stack[stack.length - 1].end && stack[stack.length - 1].start !== s.start)) stack.pop();
    const name = stack.length ? `${stack[stack.length - 1].name}.${s.short}` : s.short;
    const item = { ...s, name };
    out.push({ name, start: s.start, end: s.end });
    stack.push(item);
  }
  return out;
}

/** Find a symbol by qualified name; a unique unqualified match is accepted too. */
export function findSymbol(path: string, lines: string[], symbol: string): SymbolRange | null {
  const all = listSymbols(path, lines);
  const exact = all.filter((s) => s.name === symbol);
  if (exact.length) return exact[0];
  if (languageOf(path) === "markdown") {
    const ci = all.filter((s) => s.name.toLowerCase() === symbol.toLowerCase());
    return ci.length === 1 ? ci[0] : null;
  }
  const tail = all.filter((s) => s.name.endsWith(`.${symbol}`));
  return tail.length === 1 ? tail[0] : null;
}

/** Innermost symbol containing a line range, if it is not too large to be a useful anchor. */
export function enclosingSymbol(path: string, lines: string[], start: number, end: number, maxLines = 80): SymbolRange | null {
  const candidates = listSymbols(path, lines).filter((s) => s.start <= start && end <= s.end && s.end - s.start < maxLines);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.end - a.start - (b.end - b.start));
  const best = candidates[0];
  // Only use names that resolve back to the same range.
  const back = findSymbol(path, lines, best.name);
  return back && back.start === best.start && back.end === best.end ? best : null;
}

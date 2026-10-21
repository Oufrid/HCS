// Deterministic audit of any hand-written context file (AGENTS.md, CLAUDE.md, README, a summary...).

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface PathReference {
  path: string;
  line: number;
  exists: boolean;
  /** A bare file name (no directory) may be a generic mention, so a missing one is only a warning. */
  bare: boolean;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function looksLikePath(s: string): boolean {
  if (s.length < 3 || s.length > 200) return false;
  if (URL_RE.test(s) || /\s/.test(s) || /[*<>{}$|]/.test(s)) return false;
  if (s.startsWith("@") || s.startsWith("-")) return false;
  // A lone extension such as ".md" names a format, not a file.
  if (/^\.[a-z]{1,4}$/i.test(s)) return false;
  // Needs a directory separator or a file extension, and no code-ish characters.
  if (!/[/\\]/.test(s) && !/\.[A-Za-z0-9]{1,8}$/.test(s)) return false;
  if (/[();=,]/.test(s)) return false;
  // Version numbers and dotted identifiers like "v1.2" or "obj.method".
  if (/^v?\d+(\.\d+)+$/.test(s)) return false;
  if (!/[/\\]/.test(s) && /^[a-z_]+\.[a-z_]+$/i.test(s) && !/\.(md|txt|json|ya?ml|toml|ts|js|py|go|rs|rb|php|java|sh|cfg|ini|lock|xml|html|css)$/i.test(s)) return false;
  return true;
}

/** Find file paths mentioned in backticks or markdown links and check that they exist under `root`. */
export function findPathReferences(text: string, root: string): PathReference[] {
  const refs: PathReference[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const candidates = [
      ...[...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1].replace(/#.*$/, "")),
    ];
    for (let c of candidates) {
      c = c.trim().replace(/^\.\//, "").replace(/:\d+(-\d+)?$/, "");
      if (!looksLikePath(c) || seen.has(c)) continue;
      seen.add(c);
      refs.push({ path: c, line: i + 1, exists: existsSync(resolve(root, c)), bare: !/[/\\]/.test(c) });
    }
  });
  return refs;
}

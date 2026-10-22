// Share of files cited by AGENTS.md/CLAUDE.md that changed after the context file was last edited (file level).
// Run after scan.mjs, from the repository root: node bench/drift/changed.mjs
import { readFileSync } from "node:fs"; import { execFileSync } from "node:child_process";
const r = JSON.parse(readFileSync("bench/drift/results.json","utf8"));
let total=0, changed=0, files=0, filesWithChanged=0, errors=0; const ages=[];
for (const x of r) for (const c of x.contexts ?? []) {
  const dir = `bench/.work/drift/${x.repo.replace("/","__")}`;
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore","pipe","ignore"], maxBuffer: 1<<28 }).trim();
  try {
    const ctxCommit = git("log","-1","--format=%ct","HEAD","--",c.file);
    const text = git("show",`HEAD:${c.file}`);
    const base = c.file.includes("/") ? c.file.slice(0,c.file.lastIndexOf("/")) : "";
    const tree = new Set(git("ls-tree","-r","--name-only","HEAD").split("\n"));
    const refs = new Set(); for (const m of text.matchAll(/`([^`\n]+)`/g)) { const p=m[1].trim().replace(/^\.\//,"").replace(/:\d+(-\d+)?$/,""); if (p.includes("/") && /\.[a-z0-9]{1,6}$/i.test(p)) refs.add(p); }
    let any=false; files++;
    for (const p of refs) { const path = tree.has(p) ? p : base && tree.has(`${base}/${p}`) ? `${base}/${p}` : null; if (!path) continue; total++;
      const t = git("log","-1","--format=%ct","HEAD","--",path); if (t && Number(t) > Number(ctxCommit)) { changed++; any=true; ages.push((Number(t)-Number(ctxCommit))/86400); } }
    if (any) filesWithChanged++;
  } catch (e) { errors++; }
}
ages.sort((a,b)=>a-b);
console.log(`existing cited files: ${total}; changed after the context file was last edited: ${changed} (${(100*changed/total).toFixed(1)}%)`);
console.log(`context files with at least one such citation: ${filesWithChanged} of ${files} (errors ${errors})`);
console.log(`median days between the context edit and the later change: ${ages[Math.floor(ages.length/2)]?.toFixed(0)}`);

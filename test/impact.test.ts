import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertComment } from "../src/github.js";
import { COMMENT_MARKER, parseUnifiedDiff } from "../src/impact.js";
import { tempProject } from "./helpers.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

test("parseUnifiedDiff: modified, added, deleted, renamed and quoted paths; deletions touch the lines around them", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3 @@ x",
    "@@ -10,2 +10,0 @@",
    "@@ -20,0 +18,3 @@",
    "diff --git a/new.md b/new.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.md",
    "@@ -0,0 +1,2 @@",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,4 +0,0 @@",
    "diff --git a/lib/x.ts b/lib/y.ts",
    "similarity index 100%",
    "rename from lib/x.ts",
    "rename to lib/y.ts",
    'diff --git "a/sp ace.md" "b/sp ace.md"',
    '--- "a/sp ace.md"',
    '+++ "b/sp ace.md"',
    "@@ -1 +1,2 @@",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [
    { path: "src/a.ts", status: "modified", hunks: [{ start: 3, end: 3 }, { start: 10, end: 11 }, { start: 18, end: 20 }] },
    { path: "new.md", status: "added", hunks: [{ start: 1, end: 2 }] },
    { path: "old.txt", status: "deleted", hunks: [{ start: 1, end: 1 }] },
    { path: "lib/y.ts", status: "renamed", oldPath: "lib/x.ts", hunks: [] },
    { path: "sp ace.md", status: "modified", hunks: [{ start: 1, end: 2 }] },
  ]);
});

test("hcs impact: claims citing changed, deleted or renamed code, claims edited in the diff, markdown with links", () => {
  const dir = tempProject({
    "app/src/fee.ts": "export function fee(w: number) {\n  return 25 + w * 4;\n}\n\nexport function tax(x: number) {\n  return x * 0.2;\n}\n",
    "app/src/old.ts": "export const OLD = 1;\n",
    "app/src/moved.ts": "export const M = 2;\n",
    "app/docs/notes.md": "# Notes\n\nline\n",
    "app/project.hcs":
      "HCS/0.2\n@title t\n[claims]\n#fee[manual] Fee is 25 plus 4 per kg.\n  > src/fee.ts::fee\n#tax[manual] Tax is 20%.\n  > src/fee.ts::tax\n" +
      "#old[manual] OLD is 1.\n  > src/old.ts\n#moved[manual] M is 2.\n  > src/moved.ts:1\n#notes[manual] Notes exist.\n  > docs/notes.md::Notes\n" +
      "[probes]\n?p1 What is the base fee?\n  = 25\n  > src/fee.ts:2\n",
  });
  const app = join(dir, "app");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: app, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    assert.equal(run("seal", "project.hcs").status, 0);
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();

    // The pull request: change fee's body, delete old.ts, rename moved.ts, reword one claim and re-seal (still "ok").
    writeFileSync(join(app, "src/fee.ts"), "export function fee(w: number) {\n  return 30 + w * 4;\n}\n\nexport function tax(x: number) {\n  return x * 0.2;\n}\n");
    unlinkSync(join(app, "src/old.ts"));
    mkdirSync(join(app, "lib"));
    renameSync(join(app, "src/moved.ts"), join(app, "lib/moved.ts"));
    const hcs = join(app, "project.hcs");
    writeFileSync(hcs, readFileSync(hcs, "utf8").replace("Fee is 25 plus 4 per kg.", "Fee is 30 plus 4 per kg."));
    assert.equal(run("seal", "project.hcs", "--rehash", "--ids", "fee").status, 0);
    git("add", "-A");

    const r = run("impact", "project.hcs", "--base", base, "--json");
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    const byId = Object.fromEntries(report.items.map((i: any) => [i.id, i]));
    assert.deepEqual(Object.keys(byId).sort(), ["fee", "moved", "old", "p1"], "tax and notes are untouched");
    assert.equal(byId.fee.status, "ok", "re-sealed by the author, still reported for review");
    assert.match(byId.fee.anchors[0].reason, /^changed lines 2/);
    assert.equal(byId.old.anchors[0].reason, "file deleted");
    assert.equal(byId.moved.anchors[0].reason, "file renamed to lib/moved.ts");
    assert.equal(byId.p1.status, "stale");
    assert.deepEqual(report.claimsEdited, ["fee"]);
    assert.equal(report.filesChanged, 4);

    const md = run("impact", "project.hcs", "--base", base, "--format", "markdown", "--link-base", "https://github.com/o/r/blob/abc");
    assert.ok(md.stdout.startsWith(COMMENT_MARKER));
    assert.match(md.stdout, /3 claim\(s\) and 1 probe\(s\) in `project.hcs` cite code changed here/);
    assert.match(md.stdout, /\[`src\/fee.ts::fee`\]\(https:\/\/github.com\/o\/r\/blob\/abc\/app\/src\/fee.ts#L1-L3\)/, "links include the path from the repository top");
    assert.match(md.stdout, /Claims changed in `project.hcs` by this diff: edited `fee`/);

    const text = run("impact", "project.hcs", "--base", "HEAD");
    assert.match(text.stdout, /fee .*\[ok\] Fee is 30/);
    assert.equal(run("impact", "project.hcs").status, 2, "--base is required");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("upsertComment creates one comment, then updates it; a quiet report is not posted on a fresh pull request", async () => {
  const comments: { id: number; body: string }[] = [{ id: 1, body: "unrelated" }];
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, "Bearer t0ken");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify(comments));
      const body = JSON.parse(raw).body;
      if (req.method === "POST") {
        comments.push({ id: 2, body });
        return res.end(JSON.stringify(comments[1]));
      }
      comments.find((c) => req.url?.endsWith(`/comments/${c.id}`))!.body = body;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ctx = { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t0ken", repository: "o/r", pullNumber: 7 };
  try {
    assert.equal(await upsertComment(ctx, COMMENT_MARKER, `${COMMENT_MARKER}\nnothing`, true), "skipped");
    assert.equal(await upsertComment(ctx, COMMENT_MARKER, `${COMMENT_MARKER}\nfirst`), "created");
    assert.equal(await upsertComment(ctx, COMMENT_MARKER, `${COMMENT_MARKER}\nsecond`, true), "updated");
    assert.equal(comments.length, 2, "never duplicated");
    assert.equal(comments[1].body, `${COMMENT_MARKER}\nsecond`);
    assert.deepEqual(calls.filter((c) => !c.startsWith("GET")), ["POST /repos/o/r/issues/7/comments", "PATCH /repos/o/r/issues/comments/2"]);
  } finally {
    server.close();
  }
});

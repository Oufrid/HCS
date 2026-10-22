# Drift in real agent context files

`scan.mjs` takes 50 popular public repositories (`repos.txt`), clones them without file contents (history since
2024-06-01) and, for every `AGENTS.md` and `CLAUDE.md` in them, lists the repository paths they mention in inline
code or links. Deterministic, no LLM. Raw output: `results.json`, `scan.txt`, `changed-after-edit.txt`.

Path detection is deliberately conservative: only tokens with a `/` count, placeholders (`src/foo/bar.py`,
`vYYYY_MM_DD.py`, `...`) are skipped, and a path is accepted if any file or directory in the tree ends with it
(monorepo packages). A path counts as **confirmed broken** only if it existed in the repository's history and is
gone now; paths that never existed in the history (generated files, external repositories, typos) are not counted.

## Results (2026-10-22)

- 33 of the 50 repositories have at least one `AGENTS.md` or `CLAUDE.md` (158 files, 1,050 path references; 3
  repositories could not be cloned).
- **Confirmed broken references: 6 of 33 repositories (18%), 7 of 158 files, 13 of 1,050 references (1.2%).**
  Examples: bun's `CLAUDE.md` cites `src/shell` and `src/bake` (removed 2026-05-14); prisma's `AGENTS.md` cites
  six paths removed between 2026-05 and 2026-07; airflow's cites `tests/cli/test_cli_parser.py` (removed
  2025-03-21).
- `changed.mjs`: of the 427 cited files that still exist, **127 (29.7%) changed after the context file citing
  them was last edited** (median 5 days later); 46 of the 158 context files have at least one such citation. This
  is file-level and an upper bound on what needs review: most changes to a cited file do not touch the cited part,
  and line or symbol anchors would flag fewer.

What it shows: broken references in agent files are real but rare per reference; what changes underneath is
common. Broken paths are what the many existing linters check (see PRIOR_ART.md); detecting changes to the cited
code, at line or symbol level, is what content hashes add. Not measured: how many statements became false.

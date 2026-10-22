# A real MCP session: Claude Code with `hcs serve`

Recorded on 2026-10-21 with Claude Code 2.1.306 (`claude -p`, model chosen by Claude Code) against `hcs serve session.hcs --allow-write`,
where `session.hcs` was a copy of `project.hcs` at commit `681f82e`. Raw stream: `mcp-session-2026-10-21.jsonl.gz`
(`claude --output-format stream-json --verbose`). Tool results are shortened here; nothing else is edited. The model's
final summary is in French because the repository's `CLAUDE.md` asks agents to answer the maintainer in French.

Command:

```bash
claude -p "<the prompt below>" --mcp-config mcp-write.json --strict-mcp-config \
  --allowedTools "mcp__hcs__hcs_context,mcp__hcs__hcs_search,mcp__hcs__hcs_expand,mcp__hcs__hcs_source,mcp__hcs__hcs_record,mcp__hcs__hcs_verify,ListMcpResourcesTool,ReadMcpResourceTool" \
  --no-session-persistence --max-budget-usd 0.5 --output-format stream-json --verbose
```

`mcp-write.json`:

```json
{ "mcpServers": { "hcs": { "command": "node", "args": ["/home/user/HCS/dist/src/cli.js", "serve", "session.hcs", "--allow-write"] } } }
```

## Prompt

> You are testing the hcs MCP server. Do these steps in order and report each result briefly: 1) call hcs_context with budget 600; 2) call hcs_search for 'quota'; 3) call hcs_expand on the first claim id that search returned; 4) read the MCP resource hcs://claim/<that same id>; 5) open src/llm.ts with hcs_source using symbol MAX_RETRY_WAIT_MS, then record with hcs_record one factual claim about that constant, anchored to src/llm.ts::MAX_RETRY_WAIT_MS; 6) call hcs_verify on the new claim id. Do not use any other tool.

## Connection

- MCP servers: `[{"name": "hcs", "status": "connected", "source": "dynamic"}]`
- HCS tools seen by the client: `mcp__hcs__hcs_context`, `mcp__hcs__hcs_expand`, `mcp__hcs__hcs_record`, `mcp__hcs__hcs_search`, `mcp__hcs__hcs_source`, `mcp__hcs__hcs_verify`

**Call** `mcp__hcs__hcs_context` `{"budget": 600}`

**Call** `mcp__hcs__hcs_search` `{"query": "quota"}`

Result:

```
<hcs-context title="HCS - Holographic Context Standard (reference CLI)">
[Overview]
purpose: HCS is a plain-text format plus a zero-dependency Node.js CLI and MCP server (`hcs`) that makes LLM context traceable (claims cite sources), verifiable (anchors carry hashes) and measured (probes and fidelity certificates). (README.md:3-16)
layers: Deterministic commands (init, validate, check, seal, render, stats, audit, serve) never call an LLM; compile, score and snapshot need a `provider:model` LLM; models only lists a provider's model ids. (src/cli.ts::HELP)
[Format]
magic: A file starts with `HCS/0.3` (0.1 and 0.2 are still accepted, and the writer emits 0.2 unless a probe has tags), then `@key value` headers, then optional [claims], [probes] and [certificates] blocks; errors carry line numbers. (src/format.ts::parse; src/format.ts::SUPPORTED_VERSIONS)
anchor-syntax: Anchors are `> path`, `> path:start-end` or `> path::Symbol`, optionally followed by `#hash`; quoted forms allow spaces in paths and symbols. (src/format.ts::parseAnchor; src/format.ts::formatAnchor)
[Verification]
hash: Hashes are the first 12 hex chars of SHA-256 over LF-normalized text without trailing whitespace; symbol anchors also remove all whitespace, so reformatting does not break them. (src/anchors.ts::HASH_LENGTH; src/anchors.ts::normalizeLines; src/anchors.ts::hashSymbolLines)
statuses: checkAnchor returns ok, moved (same text elsewhere in the file, or the same symbol in another file), stale, missing or unsealed; an item takes the worst status of its anchors. (src/anchors.ts::checkAnchor; src/anchors.ts::checkSymbolAnchor; src/anchors.ts::findMovedSymbol)
symbols: Symbols are located without dependencies for brace languages, Python, Markdown headings, YAML and JSON, ignoring strings, regex literals and comments; unresolvable symbols are reported missing, never guessed. (src/symbols.ts::listSymbols; src/symbols.ts::codeOnly)
</hcs-context>
```

Result:

```
resume [ok]: When the quota runs out, or a reply has no usable JSON, compile keeps what it extracted and lists the missing chunks in the `@incomplete` header; `compile --update` then compiles only those chunks. (src/compile.ts::compile)
providers [ok]: Providers are openai (any compatible API), ollama, gemini, groq, openrouter and anthropic, called at temperature 0 with usage accounting; Bearer keys may be absent when a proxy injects them; 429/503 retries honor Retry-After and Google's retryDelay, and waits over 120 s, or a provider still failing after every retry, raise a quota error. (src/llm.ts::postJSON; src/llm.ts::retryDelayMs; src/llm.ts::MAX_RETRY_WAIT_MS)
```

**Model:**

First id is "resume".

**Call** `mcp__hcs__hcs_expand` `{"id": "resume"}`

Result:

```
resume: When the quota runs out, or a reply has no usable JSON, compile keeps what it extracted and lists the missing chunks in the `@incomplete` header; `compile --update` then compiles only those chunks.
status: ok

--- src/compile.ts::compile [ok]
src/compile.ts:235-396
235| export async function compile(opts: CompileOptions): Promise<{ doc: HcsDocument; stats: CompileStats }> {
236|   const log = opts.onProgress ?? (() => {});
237|   const root = resolve(opts.root);
238|   const files = collectSources(root, opts.paths, { ignore: opts.ignore, maxBytes: opts.maxBytes });
239|   const cache = new SourceCache(root);
240| 
241|   // Incremental mode: keep what still verifies, re-read only files that changed or are new.
... (114 more lines)
```

**Call** `ReadMcpResourceTool` `{"server": "hcs", "uri": "hcs://claim/resume"}`

Result:

```
{"contents":[{"uri":"hcs://claim/resume","mimeType":"text/plain","text":"resume: When the quota runs out, or a reply has no usable JSON, compile keeps what it extracted and lists the missing chunks in the `@incomplete` header; `compile --update` then compiles only those chunks.\nstatus: ok\n\n--- src/compile.ts::compile [ok]\nsrc/compile.ts:235-396\n235| export async function compile(opts: CompileOptions): Promise<{ doc: HcsDocument; stats: CompileStats }> {\n236|   const log = opts.onProgress ?? (() => {});\n237|   const root = resolve(opts.root);\n238|   const files = collectSources(root, opts.paths, { ignore: opts.ignore, maxBytes: opts.maxBytes });\n239|   const cache = new SourceCache(root);\n240| \n241|   // Incremental mode: keep what still verifies, re-read only files that changed or are new.\n242|   const chunkLines = opts.chunkLines ?? 250;\n243|   const texts = new Map(files.map((f) => [f, readFileSync(resolve(root, f), \"utf8\")]));\n244|   const chunkKey = (c: Chunk) => `${c.path}:${c.start}-${c.end}`;\n245| \n246|   // Incremental mode: keep what still verifies, re-read only files that changed or are new.\n247|   let kept: Claim[] = [];\n248|   let keptProbes: Probe[] = [];\n249|   let toCompile = files;\n250|   /** Unchanged files that a quota-interrupted run left unfinished: only their missing chunks are compiled. */\n251|   const resume = new Map<string, Set<string>>();\n252|   if (opts.previous) {\n253|     const prev = structuredClone(opts.previous);\n254|     seal(prev, cache); // follow moved anchors\n255|     const status = new Map(checkDocument(prev, cache).map((r) => [`${r.kind}:${r.id}`, r.status]));\n256|     const fresh = (kind: string, id: string) => {\n257|       const s = status.get(`${kind}:${id}`);\n258|       return s === \"ok\" || s === \"moved\";\n259|     };\n260|     const dirty = new Set<string>();\n261|     for (const item of [...prev.claims, ...prev.probes]) {\n262|       const kind = \"question\" in item ? \"probe\" : \"claim\";\n263|       if (!fresh(kind, item.id)) item.anchors.forEach((a) => dirty.add(a.path));\n264|     }\n265|     // Hand-written claims do not count: a file only they cite was never machine-compiled.\n266|     const generated = [...prev.claims.filter((c) => !c.tags.includes(\"manual\")), ...prev.probes];\n267|     const covered = new Set(generated.flatMap((i) => i.anchors.map((a) => a.path)));\n268|     for (const key of (prev.headers.incomplete ?? \"\").split(\",\").filter(Boolean)) {\n269|       const path = key.replace(/:\\d+-\\d+$/, \"\");\n270|       if (!texts.has(path)) continue;\n271|       // Resume chunk by chunk only if the file still splits into the same chunks; otherwise redo the file.\n272|       const same = chunkFile(path, texts.get(path)!, chunkLines).some((c) => chunkKey(c) === key);\n273|       if (same && covered.has(path) && !dirty.has(path)) resume.set(path, (resume.get(path) ?? new Set()).add(key));\n274|       else dirty.add(path);\n275|     }\n276|     toCompile = files.filter((f) => dirty.has(f) || !covered.has(f) || resume.has(f));\n277|     const recompiled = new Set(toCompile.filter((f) => !resume.has(f)));\n278|     const touchesRecompiled = (i: Claim | Probe) => i.anchors.some((a) => recompiled.has(a.path));\n279|     kept = prev.claims.filter((c) => {\n280|       if (c.tags.includes(\"manual\")) return true; // human claims are never dropped automatically\n281|       if (c.tags.includes(\"overview\")) return false; // regenerated below\n282|       return fresh(\"claim\", c.id) && !touchesRecompiled(c);\n283|     });\n284|     keptProbes = prev.probes.filter((p) => fresh(\"probe\", p.id) && !touchesRecompiled(p));\n285|     log(`incremental: ${files.length - toCompile.length} files unchanged, ${toCompile.length} to compile${resume.size ? ` (${resume.size} resumed after a quota stop)` : \"\"}`);\n286|   }\n287| \n288|   const chunks: { chunk: Chunk; profile: Profile }[] = [];\n289|   let sourceTokens = 0;\n290|   const sourceFindings: SourceFinding[] = [];\n291|   for (const f of files) {\n292|     const text = texts.get(f)!;\n293|     sourceTokens += estimateTokens(text);\n294|     if (!toCompile.includes(f)) continue;\n295|     sourceFindings.push(...scanSource(f, text));\n296|     const profile = profileFor(f, text);\n297|     const only = resume.get(f);\n298|     for (const chunk of chunkFile(f, text, chunkLines)) if (!only || only.has(chunkKey(chunk))) chunks.push({ chunk, profile });\n299|   }\n300| \n301|   let done = 0;\n302|   // A free-tier quota can run out mid-run. Keep what was extracted, stop sending requests, and record the\n303|   // chunks that were not compiled (`@incomplete`) so that `--update` resumes exactly there.\n304|   let quota: QuotaError | undefined;\n305|   const unfinished: string[] = [];\n306|   let unusable = 0;\n307|   const results = await mapLimit(chunks, opts.concurrency ?? 4, async ({ chunk, profile }) => {\n308|     const empty = { claims: [], probes: [], proposedClaims: 0, proposedProbes: 0 };\n309|     if (quota) {\n310|       unfinished.push(chunkKey(chunk));\n311|       return empty;\n312|     }\n313|     const fileLines = opts.anchorMode === \"lines\" ? undefined : cache.lines(chunk.path) ?? undefined;\n314|     let r: Awaited<ReturnType<typeof extractChunk>>;\n315|     try {\n316|       r = await extractChunk(opts.llm, chunk, profile, opts, fileLines);\n317|     } catch (e) {\n318|       if (!(e instanceof QuotaError)) throw e;\n319|       quota ??= e;\n320|       unfinished.push(chunkKey(chunk));\n321|       log(`[${++done}/${chunks.length}] ${chunkKey(chunk)} -> not compiled: quota exhausted`);\n322|       return empty;\n323|     }\n324|     if (r.unusable) {\n325|       unusable++;\n326|       unfinished.push(chunkKey(chunk));\n327|       log(`[${++done}/${chunks.length}] ${chunkKey(chunk)} -> no usable JSON in the reply (truncated or malformed)`);\n328|       return r;\n329|     }\n330|     log(`[${++done}/${chunks.length}] ${chunkKey(chunk)} -> ${r.claims.length} claims, ${r.probes.length} probes`);\n331|     return r;\n332|   });\n333| \n334|   const newClaims = results.flatMap((r) => r.claims.map((x) => x.claim));\n335|   const manualAndKept = kept.filter((c) => !c.tags.includes(\"overview\"));\n336|   let claims = [...manualAndKept, ...newClaims];\n337| \n338|   // Stable, readable ids: number everything in document order.\n339|   const doc = emptyDocument(opts.title ?? opts.previous?.headers.title ?? \"Untitled\");\n340|   if (opts.previous) {\n341|     doc.headers = { ...opts.previous.headers };\n342|     doc.meta = { ...opts.previous.meta };\n343|   }\n344|   const renumber = (list: Claim[]) => list.forEach((c, i) => (c.id = `c${i + 1}`));\n345|   claims = sortBySection(claims);\n346|   renumber(claims);\n347| \n348|   if (opts.synthesize !== false && !quota) {\n349|     try {\n350|       const overview = await synthesize(opts.llm, claims, doc.headers.title);\n351|       if (overview.length) log(`synthesized ${overview.length} overview claims`);\n352|       claims = [...overview, ...claims];\n353|       renumber(claims);\n354|     } catch (e) {\n... (42 more lines; use hcs_source with start/end)"}]}
```

**Call** `mcp__hcs__hcs_source` `{"path": "src/llm.ts", "symbol": "MAX_RETRY_WAIT_MS"}`

Result:

```
src/llm.ts:153-153
153| const MAX_RETRY_WAIT_MS = 120_000;
```

**Call** `mcp__hcs__hcs_record` `{"text": "MAX_RETRY_WAIT_MS is a module-level constant in src/llm.ts set to 120_000 (120 seconds), the longest retry wait the LLM client accepts.", "anchors": ["src/llm.ts::MAX_RETRY_WAIT_MS"]}`

Result:

```
recorded r1: MAX_RETRY_WAIT_MS is a module-level constant in src/llm.ts set to 120_000 (120 seconds), the longest retry wait the LLM client accepts.
  > src/llm.ts::MAX_RETRY_WAIT_MS #ffea888e2d7e
Run `hcs check` to verify it later; it goes stale when the cited source changes.
```

**Call** `mcp__hcs__hcs_verify` `{"ids": ["r1"]}`

Result:

```
1 item(s): 1 ok
r1: ok
```

**Model:**

Les six étapes se sont exécutées sans erreur.

1. **`hcs_context` (budget 600)** : le serveur a renvoyé 3 sections (Overview, Format, Verification) avec 7 claims. Tous cités avec leurs sources.
2. **`hcs_search "quota"`** : 2 résultats, `resume` puis `providers`, tous deux au statut ok. Le premier est `resume`.
3. **`hcs_expand resume`** : statut ok. La source citée est `src/compile.ts::compile` (lignes 235-396). La sortie est tronquée après la ligne 353, avec « 42 more lines ». Le code montre la gestion de `QuotaError`, la liste `unfinished` et le header `@incomplete`.
4. **Ressource `hcs://claim/resume`** : lue avec succès. Le contenu est identique à celui de l'étape 3, enveloppé en JSON (`mimeType: text/plain`).
5. **`hcs_source` puis `hcs_record`** :
   - `src/llm.ts::MAX_RETRY_WAIT_MS` correspond à la ligne 153, `const MAX_RETRY_WAIT_MS = 120_000;`.
   - Le claim **r1** a été enregistré : « MAX_RETRY_WAIT_MS is a module-level constant in src/llm.ts set to 120_000 (120 seconds), the longest retry wait the LLM client accepts. »
   - Son ancre est `src/llm.ts::MAX_RETRY_WAIT_MS` avec le hash `#ffea888e2d7e`.
6. **`hcs_verify r1`** : 1 élément vérifié, r1 est **ok**.

L'étape 5 a modifié `project.hcs`, puisque `hcs_record` y écrit r1. Je n'ai pas lancé `git status` ni commité, car vous m'avez demandé de n'utiliser aucun autre outil.

## End

- Outcome: success, 9 turns, $0.1192 reported by Claude Code.
- Afterwards `hcs check session.hcs --strict` printed `OK: every claim still matches its sources.`

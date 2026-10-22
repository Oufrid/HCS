#!/usr/bin/env node
// Quote-verification rate of real compile replies, recomputed offline from an HCS_DEBUG_LOG file.
// Compares the original matcher (whitespace and case only) with the current one (also ignores Markdown markup),
// on exactly the same model replies, so the difference is due to the matcher alone.
//
//   node bench/quote-rate.mjs <debug-log.jsonl> [more.jsonl...]
//
// Needs a build (`npm run build`). Prints one line per log and a JSON summary on the last line.

import { readFileSync } from "node:fs";
import { extractJSON } from "../dist/src/llm.js";
import { locateQuote } from "../dist/src/sources.js";

/** The matcher before 2026-10-21: whitespace and case only. */
function locateQuoteV1(chunk, quote) {
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (q.length < 3) return false;
  return chunk.lines.map(norm).join(" ").includes(q);
}

/** Rebuild the chunk from the numbered source block of an extraction prompt. */
function chunkFromPrompt(prompt) {
  const m = /<source path="([^"]+)">\n([\s\S]*?)\n<\/source>/.exec(prompt);
  if (!m) return null;
  const rows = m[2].split("\n").map((l) => /^\s*(\d+)\| ?(.*)$/.exec(l)).filter(Boolean);
  return { path: m[1], start: Number(rows[0][1]), end: Number(rows.at(-1)[1]), lines: rows.map((r) => r[2]) };
}

const summary = [];
for (const file of process.argv.slice(2)) {
  const tally = { file, chunks: 0, unparsable: 0, items: 0, v1: 0, v2: 0, docs: { items: 0, v1: 0, v2: 0 }, code: { items: 0, v1: 0, v2: 0 } };
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    const chunk = entry.reply && chunkFromPrompt(entry.request.prompt);
    if (!chunk) continue;
    tally.chunks++;
    let data;
    try {
      data = extractJSON(entry.reply);
    } catch {
      tally.unparsable++;
      continue;
    }
    const kind = /\.(md|txt|rst)$/i.test(chunk.path) ? "docs" : "code";
    for (const item of [...(data.claims ?? []), ...(data.probes ?? [])]) {
      if (typeof item?.quote !== "string") continue;
      const v1 = locateQuoteV1(chunk, item.quote);
      const v2 = !!locateQuote(chunk, item.quote);
      for (const t of [tally, tally[kind]]) {
        t.items++;
        t.v1 += v1 ? 1 : 0;
        t.v2 += v2 ? 1 : 0;
      }
    }
  }
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  console.log(
    `${file}: ${tally.chunks} chunks (${tally.unparsable} unparsable), ${tally.items} quotes; ` +
      `accepted v1 ${tally.v1} (${pct(tally.v1, tally.items)}), v2 ${tally.v2} (${pct(tally.v2, tally.items)}); ` +
      `docs v1 ${pct(tally.docs.v1, tally.docs.items)} -> v2 ${pct(tally.docs.v2, tally.docs.items)} of ${tally.docs.items}; ` +
      `code v1 ${pct(tally.code.v1, tally.code.items)} -> v2 ${pct(tally.code.v2, tally.code.items)} of ${tally.code.items}`,
  );
  summary.push(tally);
}
console.log(JSON.stringify(summary));

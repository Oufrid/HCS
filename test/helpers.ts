import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompletionRequest, LLM } from "../src/llm.js";

export function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hcs-test-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

export const FIXTURE: Record<string, string> = {
  "src/rates.ts": [
    "// Shipping rates.",
    "export const BASE_FEE = 25;",
    "",
    "export function shippingFee(weightKg: number): number {",
    "  if (weightKg > 30) throw new Error(\"too heavy\");",
    "  return BASE_FEE + weightKg * 4;",
    "}",
    "",
  ].join("\n"),
  "docs/policy.md": [
    "# Refund policy",
    "",
    "Refunds are accepted within 14 days of delivery.",
    "Opened software is never refunded.",
    "",
  ].join("\n"),
};

/**
 * A deterministic stand-in for a model. It reads the numbered source in extraction prompts and
 * quotes real lines, plus one fabricated quote that the compiler must reject.
 */
export class FakeLLM implements LLM {
  id = "fake:model";
  calls: CompletionRequest[] = [];

  async complete(req: CompletionRequest): Promise<string> {
    this.calls.push(req);
    const p = req.prompt;

    const src = /<source path="([^"]+)">\n([\s\S]*?)\n<\/source>/.exec(p);
    if (src) {
      const lines = src[2].split("\n").map((l) => {
        const m = /^\s*(\d+)\| (.*)$/.exec(l);
        return { n: Number(m![1]), text: m![2] };
      });
      const content = lines.filter((l) => l.text.trim() && !l.text.startsWith("//") && !l.text.startsWith("#"));
      const claims = content.slice(0, 3).map((l, i) => ({
        text: `${src[1]} states: ${l.text.trim()}`,
        quote: l.text.trim(),
        lines: [l.n, l.n],
        importance: 5 - i,
      }));
      claims.push({ text: "Invented fact", quote: "this text is not in the source", lines: [1, 1], importance: 5 });
      const probes = content.slice(0, 1).map((l) => ({
        question: `What does ${src[1]} say about "${l.text.trim().slice(0, 14)}"?`,
        answer: l.text.trim(),
        quote: l.text.trim(),
        lines: [l.n, l.n],
      }));
      probes.push({ question: "Fabricated?", answer: "yes", quote: "nope not here", lines: [1, 1] });
      return "Here you go:\n```json\n" + JSON.stringify({ claims, probes }) + "\n```";
    }

    if (p.includes('"overview"')) {
      return JSON.stringify({ overview: [{ text: "The project has shipping rates and a refund policy.", supports: ["c1", "c2", "c999"] }] });
    }

    if (p.startsWith("Question:")) {
      const ref = /Reference answer: (.*)\nCandidate answer: (.*)\n/.exec(p)!;
      return JSON.stringify({ verdict: ref[2].includes(ref[1]) ? "correct" : "incorrect" });
    }

    // Answering: find the claim the question points at.
    const q = /What does (\S+) say about "(.*)"\?/.exec(p);
    if (q && p.includes("<hcs-context")) {
      const ctx = p.split("\n").find((l) => l.includes(`${q[1]} states: ${q[2]}`));
      return ctx ? ctx.replace(/^c\d+: .*? states: /, "").replace(/ \(.*\)$/, "") : "UNKNOWN";
    }
    return "UNKNOWN";
  }
}

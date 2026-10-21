// Prompt-injection guard. Claims are rendered into other models' prompts, so text that tries to give
// those models instructions must not travel silently. Pattern-based: it catches common attacks, not all.

export type Severity = "high" | "low";

/**
 * "high": almost never legitimate in a factual claim; the claim is tagged `suspect` and kept out of renders.
 * "low": can be legitimate (a project about LLMs mentions system prompts); only reported for human review.
 */
const PATTERNS: { re: RegExp; reason: string; severity: Severity }[] = [
  { re: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding|your|these|those)\s+(instructions?|prompts?|rules|guidelines|directives)\b/i, reason: "asks to ignore instructions", severity: "high" },
  { re: /<\/?(system|assistant|user|instructions?)>|\[\/?INST\]|<\|im_(start|end)\|>|<\|(system|user|assistant)\|>/i, reason: "contains chat-template markers", severity: "high" },
  { re: /\b(do not|don't|never) (tell|inform|reveal to|show) (the )?user\b/i, reason: "asks to hide information from the user", severity: "high" },
  { re: /\byou are now\b|\bfrom now on,? you\b|\bpretend (to be|you are)\b/i, reason: "tries to change the model's role", severity: "high" },
  { re: /\b(system|developer) (prompt|message|instructions?)\b/i, reason: "mentions system or developer prompts", severity: "low" },
  { re: /\b(new|updated|real|actual) instructions?\b/i, reason: "announces new instructions", severity: "low" },
  { re: /\b(run|execute|eval)\b[^.\n]{0,30}\b(curl|wget|bash|sh|powershell|rm -rf|base64)\b/i, reason: "mentions running shell commands", severity: "low" },
  { re: /\b(send|post|upload|exfiltrate|leak)\b[^.\n]{0,40}\b(api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|env(ironment)? var)/i, reason: "mentions sending secrets", severity: "low" },
  { re: /\b(always|must)\b[^.\n]{0,30}\b(respond|reply|answer)\b[^.\n]{0,20}\b(with|that)\b/i, reason: "dictates how a model must answer", severity: "low" },
];

export interface Finding {
  reason: string;
  severity: Severity;
}

/** Ways the text looks like an instruction aimed at a model; empty when it looks like plain content. */
export function injectionFindings(text: string): Finding[] {
  return PATTERNS.filter((p) => p.re.test(text)).map(({ reason, severity }) => ({ reason, severity }));
}

export function isHighRisk(text: string): boolean {
  return injectionFindings(text).some((f) => f.severity === "high");
}

export const SUSPECT_TAG = "suspect";

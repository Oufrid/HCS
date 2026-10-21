// Prompt-injection guard. Claims are rendered into other models' prompts, so text that tries to give
// those models instructions must not travel silently. Pattern-based: it catches common attacks, not all.

export type Severity = "high" | "low";

/**
 * "high": almost never legitimate in a factual claim; the claim is tagged `suspect` and kept out of renders.
 * "low": can be legitimate (a project about LLMs mentions system prompts); only reported for human review.
 */
const AI = String.raw`(?:ai|llms?|language models?|assistants?|chatbots?|copilot|chatgpt|claude|gemini|models?)`;
const SECRET = String.raw`(?:api[ _-]?keys?|tokens?|secrets?|passwords?|credentials?|cookies?|\.env|env(?:ironment)? var(?:iable)?s?|conversation|chat history|email address(?:es)?|ssh keys?)`;

const PATTERNS: { re: RegExp; reason: string; severity: Severity }[] = [
  // Overriding the model's instructions.
  { re: /\b(ignore|disregard|forget|override|bypass)\s+(?:\w+\s+){0,3}?(previous|prior|above|earlier|preceding|original|initial|all|any|your|safety|these|those)\s+(?:\w+\s+){0,2}?(instructions?|prompts?|rules|guidelines|directives|directions|guidance|training|policies|filters|constraints)\b/i, reason: "asks to ignore instructions", severity: "high" },
  { re: /\b(ignore|disregard|forget)\s+(everything|anything)\s+(above|before|you (were|have been) told)\b/i, reason: "asks to ignore instructions", severity: "high" },
  { re: /\bignore\b[^.\n]{0,40}\binstead,?\s+(reply|respond|answer|say|output|print)\b/i, reason: "asks to ignore instructions", severity: "high" },
  { re: /\b(new|updated|real|actual)\s+(instructions?|rules|task|goal)\s*:|\byour\s+(new|real|actual|true)\s+(task|goal|instructions?|purpose)\b/i, reason: "replaces the model's task", severity: "high" },
  { re: /\bnew system prompt\b|\bsystem override\b|\b(supersedes?|replaces?|overrides?)\b[^.\n]{0,20}\b(previous|prior|earlier)\s+(ones|instructions?|prompts?|rules)\b/i, reason: "replaces the model's task", severity: "high" },
  { re: /\byour\s+(instructions|rules|prompt|guidelines)\s+(have|has)\s+(been\s+)?(changed|updated|replaced|revoked)\b/i, reason: "replaces the model's task", severity: "high" },
  // Chat-template and role markers.
  { re: /<\/?(system|assistant|user|instructions?)>|\[\/?INST\]|<<\/?SYS>>|<\|[a-z_]+\|>|###\s*(instruction|response|system)\s*:|\[(system|assistant|user)\]\(#/i, reason: "contains chat-template markers", severity: "high" },
  // Text addressed to a model that reads it.
  { re: new RegExp(String.raw`\b(if you are|as)\s+an?\s+${AI}\b[^.\n]{0,40}\b(reading|processing|summari[sz]ing|parsing)\b|\b${AI}\s+(reading|processing|summari[sz]ing|parsing)\s+this\b`, "i"), reason: "addresses a model that reads this text", severity: "high" },
  { re: new RegExp(String.raw`\b(note|message|instructions?|attention|hidden instructions?)\s+(to|for)\s+(the\s+)?(\w+\s+)?${AI}\b`, "i"), reason: "addresses a model that reads this text", severity: "high" },
  { re: /\b(hidden|secret)\s+(instructions?|prompt)\s+(for|to)\b/i, reason: "addresses a model that reads this text", severity: "high" },
  // Hiding things from the user.
  { re: /\b(do not|don't|never)\s+(tell|inform|reveal to|show)\s+(the\s+)?user\b|\b(do not|don't|never)\s+(mention|reveal|disclose)\b[^.\n]{0,30}\bto the user\b|\bwithout (telling|informing|notifying) the user\b/i, reason: "asks to hide information from the user", severity: "high" },
  // Role changes and jailbreaks.
  { re: /\byou are now\b|\bfrom now on,? you\b|\bpretend (to be|you are)\b|\bact as an?\s+(unrestricted|unfiltered|uncensored|jailbroken|evil)\b/i, reason: "tries to change the model's role", severity: "high" },
  { re: /\b(developer|maintenance|god|jailbreak|dan)\s+mode\s+(is\s+)?(enabled|activated|on)\b|\b(without|no|disabled?)\s+(any\s+)?(content filters?|ethical guidelines|safety (rules|filters|guidelines))\b/i, reason: "tries to change the model's role", severity: "high" },
  // Prompt leaks and exfiltration.
  { re: /\b(print|reveal|output|repeat|show|leak|dump)\b[^.\n]{0,30}\b(system prompt|initial prompt|hidden (context|instructions?|prompt)|developer message|your (instructions|prompt)|words above)\b/i, reason: "asks to leak the prompt", severity: "high" },
  { re: new RegExp(String.raw`^(?=[\s\S]*\b(send|post|upload|exfiltrate|leak|forward|append|embed|include|replace)\b)(?=[\s\S]*\b${SECRET})(?=[\s\S]*https?:\/\/)`, "i"), reason: "sends private data to a URL", severity: "high" },
  // Low risk: legitimate in docs about LLMs or tooling; reported for review only.
  { re: /\b(system|developer) (prompt|message|instructions?)\b/i, reason: "mentions system or developer prompts", severity: "low" },
  { re: /\b(new|updated|real|actual) instructions?\b/i, reason: "announces new instructions", severity: "low" },
  { re: /\b(run|execute|eval)\b[^.\n]{0,30}\b(curl|wget|bash|sh|powershell|rm -rf|base64)\b/i, reason: "mentions running shell commands", severity: "low" },
  { re: new RegExp(String.raw`\b(send|post|upload|exfiltrate|leak|share|forward)\b[^.\n]{0,40}\b${SECRET}`, "i"), reason: "mentions sending secrets", severity: "low" },
  { re: /\b(always|must)\b[^.\n]{0,30}\b(respond|reply|answer)\b[^.\n]{0,20}\b(with|that)\b|\b(respond|reply|answer)\b[^.\n]{0,40}\b(every|all)\s+(future\s+)?(questions?|messages?|requests?)\b/i, reason: "dictates how a model must answer", severity: "low" },
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

export interface SourceFinding extends Finding {
  path: string;
  line: number;
}

/**
 * Scan source text line by line before it is compiled, so injection-like text in a source file is reported
 * even when no claim repeats it. Reporting only: the compiler still extracts, and tags suspect claims.
 */
export function scanSource(path: string, text: string): SourceFinding[] {
  const findings: SourceFinding[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const f of injectionFindings(l)) findings.push({ path, line: i + 1, ...f });
  });
  return findings;
}

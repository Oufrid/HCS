// Minimal, dependency-free LLM clients. Any OpenAI-compatible server works through the `openai` provider.

import { appendFileSync } from "node:fs";

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface Usage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Requests repeated because a reasoning model's hidden reasoning used the whole output budget. */
  retriedForReasoning?: number;
  /** Replies cut by the output limit (finish_reason "length") that were still returned. */
  truncated?: number;
}

export interface LLM {
  /** The `provider:model` spec this client was created from. */
  id: string;
  complete(req: CompletionRequest): Promise<string>;
  /** Requests and tokens reported by the provider so far (tokens are 0 when the provider does not report them). */
  usage?: Usage;
}

export interface LLMOptions {
  /** Maximum requests per minute for this model; also read from HCS_RPM. Free tiers need this. */
  rpm?: number;
  /**
   * Sent as `reasoning_effort` to OpenAI-compatible APIs (also read from HCS_REASONING_EFFORT). Reasoning models
   * can spend most of the output budget thinking; "low" keeps answers whole. Accepted values depend on the
   * model (Gemini 3: low/medium/high; Groq gpt-oss: low/medium/high; Groq qwen: none/default), so no default.
   */
  reasoningEffort?: string;
}

type Factory = (model: string, spec: string, usage: Usage, opts: LLMOptions) => LLM;

const providers = new Map<string, Factory>();

export function registerProvider(name: string, factory: Factory): void {
  providers.set(name, factory);
}

export function providerNames(): string[] {
  return [...providers.keys()];
}

/** Spacing requests evenly is gentler on free tiers than bursting until a 429. */
class RateLimiter {
  private next = 0;
  constructor(private intervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await sleep(at - now);
  }
}

const limiters = new Map<string, RateLimiter>();

export function createLLM(spec: string, opts: LLMOptions = {}): LLM {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`model must be "provider:model" (e.g. gemini:gemini-2.5-flash, ollama:llama3.1), got "${spec}"`);
  const name = spec.slice(0, i);
  const factory = providers.get(name);
  if (!factory) throw new Error(`unknown provider "${name}". Known: ${providerNames().join(", ")}`);
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const reasoningEffort = opts.reasoningEffort ?? env("HCS_REASONING_EFFORT");
  const llm = withDebugLog(factory(spec.slice(i + 1), spec, usage, { ...opts, reasoningEffort }));
  llm.usage = usage;
  const rpm = opts.rpm ?? (env("HCS_RPM") ? Number(env("HCS_RPM")) : undefined);
  if (!rpm || !(rpm > 0)) return llm;
  // One limiter per model spec, shared by every client of that model in the process.
  if (!limiters.has(spec)) limiters.set(spec, new RateLimiter(60_000 / rpm));
  const limiter = limiters.get(spec)!;
  return {
    id: llm.id,
    usage,
    async complete(req) {
      await limiter.wait();
      return llm.complete(req);
    },
  };
}

/**
 * With HCS_DEBUG_LOG=<file>, append every request and reply (or error) as one JSON line, to see exactly what a
 * real model returned. Never contains keys: headers are not logged.
 */
function withDebugLog(llm: LLM): LLM {
  const file = env("HCS_DEBUG_LOG");
  if (!file) return llm;
  return {
    ...llm,
    async complete(req) {
      const t0 = Date.now();
      const log = (entry: object) => appendFileSync(file, `${JSON.stringify({ model: llm.id, ms: Date.now() - t0, ...entry })}\n`);
      try {
        const reply = await llm.complete(req);
        log({ request: req, reply });
        return reply;
      } catch (e) {
        log({ request: req, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function requireEnv(name: string, provider: string): string {
  const v = env(name);
  if (!v) throw new Error(`${provider} provider needs the ${name} environment variable`);
  return v;
}

/**
 * Keys for Bearer-token APIs may be absent from the environment on purpose: an egress proxy (for example a
 * cloud sandbox's "network secret") can attach the Authorization header after the request leaves. Without a
 * key we send no header; if nothing adds one, the provider answers 401 and the error says which variable to set.
 */
function proxyableKey(name: string): string | undefined {
  return env(name);
}

/**
 * Explains an authentication failure. An egress proxy that injects a network secret reports its own view in an
 * `x-proxy-error` header: then a key *was* sent, and the provider rejected it (wrong, revoked or mis-formatted).
 * Without that header and without a key of ours, nothing authenticated the request.
 */
export function authHint(res: Response, headers: Record<string, string>, body: string): string {
  const proxy = res.headers.get("x-proxy-error");
  if (proxy) return ` (egress proxy: ${proxy}; the network secret for this host is set but was not accepted: check its value and format)`;
  const authFailure = [401, 403, 404].includes(res.status) || /authorization header|api key|unregistered callers/i.test(body);
  if (authFailure && !headers.authorization && !headers["x-api-key"]) {
    return " (no API key was sent: set the provider's *_API_KEY variable, or a network secret for this host)";
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest wait we accept before retrying; anything longer means a daily quota is exhausted. */
const MAX_RETRY_WAIT_MS = 120_000;

/** Server-suggested delay, from the Retry-After header or a Google-style `retryDelay: "38s"` in the body. */
export function retryDelayMs(headers: Headers, body: string): number | undefined {
  const h = headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(h);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (m) return Number(m[1]) * 1000;
  return undefined;
}

/** The provider cannot serve more requests for now (quota exhausted, or still unavailable after retries). */
export class QuotaError extends Error {}

async function postJSON(url: string, headers: Record<string, string>, body: unknown, attempts = 6): Promise<any> {
  let lastErr: unknown;
  let wait: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(wait ?? Math.min(MAX_RETRY_WAIT_MS, 2000 * 2 ** (attempt - 1)));
    wait = undefined;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    lastErr = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}${authHint(res, headers, text)}`);
    if (res.status === 429 || res.status === 503) {
      const suggested = retryDelayMs(res.headers, text);
      if (suggested !== undefined && suggested > MAX_RETRY_WAIT_MS) {
        const quota = /"quotaId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
        const limit = /"quotaValue"\s*:\s*"?(\d+)/.exec(text)?.[1];
        // The billed model can differ from the requested one (Google serves some aliases with another model).
        const billed = /"quotaDimensions"\s*:\s*\{[^}]*"model"\s*:\s*"([^"]+)"/.exec(text)?.[1];
        const which = quota ? `; quota ${quota}${limit ? ` = ${limit}` : ""}${billed ? ` for model ${billed}` : ""}` : "";
        throw new QuotaError(`rate limit or quota exhausted at ${url} (server asks to wait ${Math.round(suggested / 1000)}s${which}). Try later, lower --rpm, or use another model.`);
      }
      wait = suggested;
      continue;
    }
    if (res.status < 500) break;
  }
  // Still overloaded or failing after every retry: stop like a quota so that callers keep their partial work.
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  if (!/^HTTP 4\d\d /.test(message) || /^HTTP 429 /.test(message)) {
    throw new QuotaError(`provider unavailable after ${attempts} attempts: ${message.slice(0, 300)}`);
  }
  throw lastErr;
}

/** Output budget for the retry when a reasoning model used all its tokens before answering. */
export const REASONING_BUDGET = 4096;

function countUsage(usage: Usage, input: unknown, output: unknown): void {
  usage.requests++;
  if (typeof input === "number") usage.inputTokens += input;
  if (typeof output === "number") usage.outputTokens += output;
}

function openAICompatible(
  id: string,
  model: string,
  baseURL: string,
  usage: Usage,
  apiKey?: string,
  extraHeaders: Record<string, string> = {},
  opts: LLMOptions = {},
): LLM {
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  return {
    id,
    async complete(req) {
      const call = async (maxTokens: number) => {
        const data = await postJSON(url, { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders }, {
          model,
          temperature: 0,
          max_tokens: maxTokens,
          ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        });
        countUsage(usage, data?.usage?.prompt_tokens, data?.usage?.completion_tokens);
        return data;
      };
      const maxTokens = req.maxTokens ?? 2048;
      let data = await call(maxTokens);
      // Reasoning models spend output tokens on hidden reasoning first. When that uses the whole budget the
      // visible answer is empty (finish_reason "length"): retry once with room for the reasoning.
      if (!data?.choices?.[0]?.message?.content && data?.choices?.[0]?.finish_reason === "length" && maxTokens < REASONING_BUDGET) {
        usage.retriedForReasoning = (usage.retriedForReasoning ?? 0) + 1;
        data = await call(REASONING_BUDGET);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error(`unexpected response from ${url}: ${JSON.stringify(data).slice(0, 300)}`);
      if (data?.choices?.[0]?.finish_reason === "length") usage.truncated = (usage.truncated ?? 0) + 1;
      return content;
    },
  };
}

registerProvider("openai", (model, spec, usage, opts) =>
  openAICompatible(spec, model, env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1", usage, env("OPENAI_API_KEY"), {}, opts),
);

registerProvider("ollama", (model, spec, usage, opts) =>
  openAICompatible(spec, model, `${(env("OLLAMA_HOST") ?? "http://localhost:11434").replace(/\/+$/, "")}/v1`, usage, undefined, {}, opts),
);

registerProvider("gemini", (model, spec, usage, opts) =>
  openAICompatible(
    spec,
    model,
    env("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    usage,
    proxyableKey("GEMINI_API_KEY"),
    {},
    opts,
  ),
);

registerProvider("groq", (model, spec, usage, opts) =>
  openAICompatible(spec, model, env("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1", usage, proxyableKey("GROQ_API_KEY"), {}, opts),
);

registerProvider("openrouter", (model, spec, usage, opts) =>
  openAICompatible(
    spec,
    model,
    env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
    usage,
    proxyableKey("OPENROUTER_API_KEY"),
    { "x-title": "hcs-cli" },
    opts,
  ),
);

registerProvider("anthropic", (model, spec, usage) => {
  const key = requireEnv("ANTHROPIC_API_KEY", "anthropic");
  const url = `${(env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;
  return {
    id: spec,
    async complete(req) {
      const data = await postJSON(url, { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
        model,
        max_tokens: req.maxTokens ?? 2048,
        temperature: 0,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      });
      countUsage(usage, data?.usage?.input_tokens, data?.usage?.output_tokens);
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      if (!text) throw new Error(`unexpected response from ${url}: ${JSON.stringify(data).slice(0, 300)}`);
      return text;
    },
  };
});

function endpoint(provider: string): { url: string; headers: Record<string, string> } {
  const bearer = (k?: string): Record<string, string> => (k ? { authorization: `Bearer ${k}` } : {});
  switch (provider) {
    case "openai":
      return { url: `${env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"}/models`, headers: bearer(env("OPENAI_API_KEY")) };
    case "ollama":
      return { url: `${(env("OLLAMA_HOST") ?? "http://localhost:11434").replace(/\/+$/, "")}/v1/models`, headers: {} };
    case "gemini":
      return {
        url: `${env("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai"}/models`,
        headers: bearer(proxyableKey("GEMINI_API_KEY")),
      };
    case "groq":
      return { url: `${env("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1"}/models`, headers: bearer(proxyableKey("GROQ_API_KEY")) };
    case "openrouter":
      return { url: `${env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1"}/models`, headers: bearer(env("OPENROUTER_API_KEY")) };
    case "anthropic":
      return {
        url: `${(env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/models?limit=1000`,
        headers: { "x-api-key": requireEnv("ANTHROPIC_API_KEY", "anthropic"), "anthropic-version": "2023-06-01" },
      };
    default:
      throw new Error(`unknown provider "${provider}". Known: ${providerNames().join(", ")}`);
  }
}

/** Model ids a provider offers to this key, so users never have to guess names. */
export async function listModels(provider: string): Promise<string[]> {
  const { url, headers } = endpoint(provider);
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}${authHint(res, headers, text)}`);
  }
  const data = JSON.parse(text);
  const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return list
    .map((m) => String(m?.id ?? m?.name ?? "").replace(/^models\//, ""))
    .filter(Boolean)
    .sort();
}

/** Pull the first JSON object out of a model reply (tolerates prose and code fences around it). */
export function extractJSON<T = any>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  // Models often copy source code into string values without escaping it. Try once more after repairing.
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(repairJSON(c.slice(start, end + 1)));
    } catch {
      // next candidate
    }
  }
  throw new Error(`model reply did not contain valid JSON: ${text.slice(0, 200)}`);
}

/**
 * Best-effort repair of JSON written by a model: escapes double quotes inside strings (a quote is taken as
 * closing only when the next non-blank character is , : } ] or the end), raw control characters, and invalid
 * backslash escapes such as the `\s` of a copied regex.
 */
export function repairJSON(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && '"\\/bfnrtu'.includes(next)) {
        out += ch + next;
        i++;
      } else out += "\\\\";
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j === text.length || ",:}]".includes(text[j])) {
        inStr = false;
        out += ch;
      } else out += '\\"';
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/** Run async jobs with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

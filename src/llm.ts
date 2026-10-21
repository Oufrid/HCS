// Minimal, dependency-free LLM clients. Any OpenAI-compatible server works through the `openai` provider.

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LLM {
  /** The `provider:model` spec this client was created from. */
  id: string;
  complete(req: CompletionRequest): Promise<string>;
}

type Factory = (model: string, spec: string) => LLM;

const providers = new Map<string, Factory>();

export function registerProvider(name: string, factory: Factory): void {
  providers.set(name, factory);
}

export function createLLM(spec: string): LLM {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`model must be "provider:model" (e.g. openai:gpt-4o-mini, ollama:llama3.1), got "${spec}"`);
  const name = spec.slice(0, i);
  const factory = providers.get(name);
  if (!factory) throw new Error(`unknown provider "${name}". Known: ${[...providers.keys()].join(", ")}`);
  return factory(spec.slice(i + 1), spec);
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

async function postJSON(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    lastErr = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}`);
    if (res.status !== 429 && res.status < 500) break;
  }
  throw lastErr;
}

function openAICompatible(id: string, model: string, baseURL: string, apiKey?: string): LLM {
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  return {
    id,
    async complete(req) {
      const data = await postJSON(url, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, {
        model,
        temperature: 0,
        max_tokens: req.maxTokens ?? 2048,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      });
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error(`unexpected response from ${url}: ${JSON.stringify(data).slice(0, 300)}`);
      return content;
    },
  };
}

registerProvider("openai", (model, spec) =>
  openAICompatible(spec, model, env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1", env("OPENAI_API_KEY")),
);

registerProvider("ollama", (model, spec) =>
  openAICompatible(spec, model, `${(env("OLLAMA_HOST") ?? "http://localhost:11434").replace(/\/+$/, "")}/v1`),
);

registerProvider("gemini", (model, spec) =>
  openAICompatible(
    spec,
    model,
    env("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    requireEnv("GEMINI_API_KEY", "gemini"),
  ),
);

registerProvider("anthropic", (model, spec) => {
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
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      if (!text) throw new Error(`unexpected response from ${url}: ${JSON.stringify(data).slice(0, 300)}`);
      return text;
    },
  };
});

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
  throw new Error(`model reply did not contain valid JSON: ${text.slice(0, 200)}`);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDocument, seal, SourceCache } from "../src/anchors.js";
import { parse, serialize } from "../src/format.js";
import { createLLM } from "../src/llm.js";
import { renderContext } from "../src/render.js";
import { scoreDocument } from "../src/score.js";
import { FakeLLM, tempProject } from "./helpers.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

/** The mock tokenizer: one token per whitespace-separated word, plus FRAMING tokens of chat template per message. */
const FRAMING = 7;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

async function mockServer(handler: (path: string, headers: IncomingMessage["headers"], body: any) => unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(req.url ?? "", req.headers, JSON.parse(raw || "{}"))));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

const ENV = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "GEMINI_BASE_URL", "GEMINI_NATIVE_BASE_URL", "GEMINI_API_KEY"];

test("providers count tokens with their own tokenizer, without the message framing", async () => {
  const seen: { path: string; headers: IncomingMessage["headers"]; body: any }[] = [];
  const { url, server } = await mockServer((path, headers, body) => {
    seen.push({ path, headers, body });
    if (path === "/v1/messages/count_tokens") return { input_tokens: words(body.messages[0].content) + FRAMING };
    if (path.endsWith(":countTokens")) return { totalTokens: words(body.contents[0].parts[0].text) };
    return { choices: [{ message: { content: "a" }, finish_reason: "length" }], usage: { prompt_tokens: words(body.messages[0].content) + FRAMING, completion_tokens: 1 } };
  });
  try {
    Object.assign(process.env, {
      OPENAI_BASE_URL: `${url}/v1`,
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "ak-test",
      GEMINI_BASE_URL: `${url}/openai`,
      GEMINI_NATIVE_BASE_URL: `${url}/native`,
    });
    const text = "one two three four five";

    const openai = createLLM("openai:gpt-test");
    assert.equal(openai.tokenCounting, "usage");
    assert.equal(await openai.countTokens!(text), 5);
    assert.equal(await openai.countTokens!("six seven"), 2);
    const completions = seen.filter((s) => s.path === "/v1/chat/completions");
    assert.equal(completions.length, 3, "the framing is measured once per client");
    assert.ok(completions.every((s) => s.body.max_tokens === 1 && s.body.messages.length === 1));
    assert.equal(openai.usage!.requests, 3, "counting requests are reported in the usage");

    const anthropic = createLLM("anthropic:claude-test");
    assert.equal(anthropic.tokenCounting, "endpoint");
    assert.equal(await anthropic.countTokens!(text), 5);
    assert.equal(seen.find((s) => s.path === "/v1/messages/count_tokens")!.headers["x-api-key"], "ak-test");

    // Gemini: the native endpoint needs the key itself; with a proxy-injected key it falls back to usage.
    const proxied = createLLM("gemini:gemini-test");
    assert.equal(proxied.tokenCounting, "usage");
    assert.equal(await proxied.countTokens!(text), 5);
    process.env.GEMINI_API_KEY = "gk-test";
    const native = createLLM("gemini:gemini-test");
    assert.equal(native.tokenCounting, "endpoint");
    assert.equal(await native.countTokens!(text), 5);
    const call = seen.find((s) => s.path === "/native/models/gemini-test:countTokens")!;
    assert.equal(call.headers["x-goog-api-key"], "gk-test");
    assert.equal(call.headers.authorization, undefined);

    // --rpm also spaces counting requests.
    const limited = createLLM("openai:gpt-limited", { rpm: 600 });
    const t0 = Date.now();
    await limited.countTokens!("a b");
    assert.ok(Date.now() - t0 >= 90, "two requests (framing + text) are spaced by the limiter");
  } finally {
    server.close();
    for (const k of ENV) delete process.env[k];
  }
});

const DOC = `HCS/0.2
@title Tiny
@root .

[claims]
#c1 The fee is computed from weight.
  > a.ts:1
[probes]
?p1 What is the fee computed from?
  = weight
  > a.ts:1
`;

test("score and stats record a counted size; the estimate stays the default", async () => {
  const dir = tempProject({ "a.ts": "export const fee = (weight: number) => weight * 2;\n" });
  const file = join(dir, "t.hcs");
  const doc = parse(DOC);
  seal(doc, new SourceCache(dir));
  writeFileSync(file, serialize(doc));
  const { url, server } = await mockServer((_path, _headers, body) => ({
    choices: [{ message: { content: "a" } }],
    usage: { prompt_tokens: words(body.messages.at(-1).content) + FRAMING, completion_tokens: 1 },
  }));
  try {
    process.env.OPENAI_BASE_URL = `${url}/v1`;
    const status = new Map(checkDocument(doc, new SourceCache(dir)).map((r) => [`${r.kind}:${r.id}`, r.status]));
    const context = renderContext(doc);
    const plain = await scoreDocument(doc, status, { answerer: new FakeLLM() });
    assert.equal(plain.certificate.fields.tokenizer, undefined);
    assert.equal(plain.tokensCounted, undefined);
    const counted = await scoreDocument(doc, status, { answerer: new FakeLLM(), tokenizer: createLLM("openai:tok") });
    assert.equal(counted.certificate.fields.tokens, String(words(context)));
    assert.equal(counted.certificate.fields.tokenizer, "openai:tok");
    assert.equal(counted.certificate.fields.digest, plain.certificate.fields.digest, "the digest does not depend on the tokenizer");

    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, "stats", file, "--tokenizer", "openai:tok"], { env: { ...process.env, OPENAI_BASE_URL: `${url}/v1` } });
      let text = "";
      child.stdout.on("data", (c) => (text += c));
      child.stderr.on("data", (c) => (text += c));
      child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(text))));
    });
    assert.match(out, /counted by openai:tok \(prompt size of a 1-token completion\)/);
    assert.match(out, new RegExp(`rendered context  ${words(context)} tokens`));
  } finally {
    server.close();
    delete process.env.OPENAI_BASE_URL;
    rmSync(dir, { recursive: true });
  }
});

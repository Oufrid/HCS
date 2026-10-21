import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDocument, SourceCache } from "../src/anchors.js";
import { compile } from "../src/compile.js";
import { parse, serialize } from "../src/format.js";
import { createLLM, extractJSON, listModels, QuotaError, retryDelayMs } from "../src/llm.js";
import { bootstrapCI, hashForCertificate, scoreDocument } from "../src/score.js";
import { FakeLLM, FIXTURE, tempProject } from "./helpers.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

function statusOf(doc: ReturnType<typeof parse>, dir: string) {
  return new Map(checkDocument(doc, new SourceCache(dir)).map((r) => [`${r.kind}:${r.id}`, r.status]));
}

test("compile keeps only claims and probes whose quotes are really in the source", async () => {
  const dir = tempProject(FIXTURE);
  const llm = new FakeLLM();
  const { doc, stats } = await compile({ root: dir, llm, title: "Shop" });

  assert.equal(stats.files, 2);
  assert.equal(stats.claimsRejected, 2, "one fabricated claim per file");
  assert.equal(stats.probesRejected, 2, "one fabricated probe per file");
  assert.ok(!doc.claims.some((c) => c.text === "Invented fact"));
  assert.equal(doc.probes.length, 2);

  // Every anchor is sealed and verifies immediately.
  const reports = checkDocument(doc, new SourceCache(dir));
  assert.ok(reports.every((r) => r.status === "ok"), JSON.stringify(reports.filter((r) => r.status !== "ok")));

  // Overview claim: unknown supporting id c999 ignored; c1 and c2 share one heading anchor, deduplicated.
  const ov = doc.claims.find((c) => c.tags.includes("overview"))!;
  assert.equal(ov.id, "c1");
  assert.deepEqual(ov.anchors.map((a) => a.symbol), ["Refund policy"]);

  // Anchors use the enclosing symbol when there is one.
  const fee = doc.claims.find((c) => c.text.includes("BASE_FEE = 25"))!;
  assert.deepEqual([fee.anchors[0].path, fee.anchors[0].symbol], ["src/rates.ts", "BASE_FEE"]);
  const body = doc.claims.find((c) => c.text.includes("too heavy"))!;
  assert.equal(body.anchors[0].symbol, "shippingFee");

  // Line anchors on request.
  const lines = await compile({ root: dir, llm: new FakeLLM(), anchorMode: "lines", synthesize: false });
  assert.deepEqual(lines.doc.claims.find((c) => c.text.includes("BASE_FEE = 25"))!.anchors[0].start, 2);

  // Serialized output is a valid, reparseable file.
  assert.deepEqual(parse(serialize(doc)).claims, doc.claims);
  rmSync(dir, { recursive: true });
});

test("incremental compile re-reads only changed files and keeps hand-written claims", async () => {
  const dir = tempProject(FIXTURE);
  const first = await compile({ root: dir, llm: new FakeLLM(), title: "Shop" });
  first.doc.claims.push({ id: "m1", text: "Hand-written rule.", tags: ["manual"], anchors: [{ ...first.doc.claims[1].anchors[0] }] });

  writeFileSync(join(dir, "docs/policy.md"), FIXTURE["docs/policy.md"].replace("14 days", "30 days"));
  const llm = new FakeLLM();
  const second = await compile({ root: dir, llm, previous: first.doc });
  const extractionCalls = llm.calls.filter((c) => c.prompt.includes("<source path="));
  assert.equal(extractionCalls.length, 1);
  assert.ok(extractionCalls[0].prompt.includes('<source path="docs/policy.md">'));
  assert.equal(second.stats.filesCompiled, 1);
  assert.ok(second.doc.claims.some((c) => c.text === "Hand-written rule."));
  assert.ok(second.doc.claims.some((c) => c.text.includes("30 days")));
  assert.ok(!second.doc.claims.some((c) => c.text.includes("14 days")));
  assert.ok(second.doc.claims.some((c) => c.text.includes("BASE_FEE = 25")), "unchanged file's claims kept");
  rmSync(dir, { recursive: true });
});

test("score measures fidelity, baseline and binds a certificate to the context", async () => {
  const dir = tempProject(FIXTURE);
  const { doc } = await compile({ root: dir, llm: new FakeLLM(), title: "Shop" });
  const status = statusOf(doc, dir);
  const res = await scoreDocument(doc, status, { answerer: new FakeLLM(), baseline: true });
  assert.equal(res.withContext.fidelity, 1);
  assert.equal(res.baseline!.fidelity, 0);
  assert.equal(res.baseline!.abstained, 1);
  assert.equal(res.certificate.fields.fidelity, "1.000");
  assert.equal(res.certificate.fields.baseline, "0.000");
  assert.deepEqual(res.informative, { fidelity: 1, probes: 2 });
  assert.equal(res.selfJudged, true);

  const twice = await scoreDocument(doc, status, { answerer: new FakeLLM(), runs: 2 });
  assert.equal(twice.withContext.runs, 2);
  assert.deepEqual(twice.withContext.results[0].verdicts, ["correct", "correct"]);
  assert.equal(twice.certificate.fields.runs, "2");

  // A tiny budget removes the claims the probes need: fidelity drops, honestly.
  const tight = await scoreDocument(doc, status, { answerer: new FakeLLM(), budget: 25 });
  assert.ok(tight.withContext.fidelity < 1);

  // Certificate is current until a claim's source changes.
  const claimStatus = (d: typeof doc) =>
    new Map([...statusOf(d, dir)].filter(([k]) => k.startsWith("claim:")).map(([k, v]) => [k.slice(6), v]));
  assert.equal(hashForCertificate(doc, claimStatus(doc)), res.certificate.fields.digest);
  writeFileSync(join(dir, "src/rates.ts"), FIXTURE["src/rates.ts"].replace("BASE_FEE = 25", "BASE_FEE = 30"));
  assert.notEqual(hashForCertificate(doc, claimStatus(doc)), res.certificate.fields.digest);
  rmSync(dir, { recursive: true });
});

test("bootstrap confidence interval is reproducible and sensible", () => {
  const vals = [1, 1, 1, 0, 1, 0.5, 1, 0, 1, 1];
  const [lo, hi] = bootstrapCI(vals);
  assert.deepEqual(bootstrapCI(vals), [lo, hi]);
  assert.ok(lo < 0.75 && 0.75 < hi && lo >= 0 && hi <= 1);
  assert.deepEqual(bootstrapCI([1, 1, 1]), [1, 1]);
  const many = bootstrapCI(Array.from({ length: 400 }, (_, i) => (i % 4 ? 1 : 0)));
  assert.ok(many[1] - many[0] < hi - lo, "more probes, tighter interval");
});

test("extractJSON tolerates prose, fences and braces in strings", () => {
  assert.deepEqual(extractJSON('Sure! {"a": "x}y", "b": [1]} trailing'), { a: "x}y", b: [1] });
  assert.deepEqual(extractJSON('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => extractJSON("no json"), /did not contain valid JSON/);
});

async function mockServer(handler: (path: string, headers: IncomingMessage["headers"], body: any) => unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const out = handler(req.url ?? "", req.headers, JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

test("openai-compatible and anthropic providers send the right requests", async () => {
  const seen: { path: string; headers: IncomingMessage["headers"]; body: any }[] = [];
  const { url, server } = await mockServer((path, headers, body) => {
    seen.push({ path, headers, body });
    if (path === "/v1/messages") return { content: [{ type: "text", text: "from anthropic" }] };
    return { choices: [{ message: { content: "from openai" } }] };
  });
  try {
    process.env.OPENAI_BASE_URL = `${url}/v1`;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_BASE_URL = url;
    process.env.ANTHROPIC_API_KEY = "ak-test";
    process.env.OLLAMA_HOST = url;

    assert.equal(await createLLM("openai:gpt-test").complete({ system: "S", prompt: "P" }), "from openai");
    assert.equal(seen[0].path, "/v1/chat/completions");
    assert.equal(seen[0].headers.authorization, "Bearer sk-test");
    assert.deepEqual(seen[0].body.messages, [{ role: "system", content: "S" }, { role: "user", content: "P" }]);
    assert.equal(seen[0].body.model, "gpt-test");
    assert.equal(seen[0].body.temperature, 0);
    assert.equal(seen[0].body.reasoning_effort, undefined, "not sent unless asked: many models reject it");
    await createLLM("openai:gpt-test", { reasoningEffort: "low" }).complete({ system: "S", prompt: "P" });
    assert.equal(seen.at(-1)!.body.reasoning_effort, "low");
    seen.pop();

    assert.equal(await createLLM("anthropic:claude-test").complete({ system: "S", prompt: "P", maxTokens: 10 }), "from anthropic");
    assert.equal(seen[1].headers["x-api-key"], "ak-test");
    assert.equal(seen[1].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[1].body.system, "S");
    assert.equal(seen[1].body.max_tokens, 10);

    assert.equal(await createLLM("ollama:llama3").complete({ system: "S", prompt: "P" }), "from openai");
    assert.equal(seen[2].path, "/v1/chat/completions");
    assert.equal(seen[2].headers.authorization, undefined);
  } finally {
    server.close();
    for (const k of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OLLAMA_HOST"]) delete process.env[k];
  }
  assert.throws(() => createLLM("gpt-4"), /provider:model/);
  assert.throws(() => createLLM("nope:x"), /unknown provider/);
});

test("CLI end to end against a mock OpenAI-compatible server", async () => {
  const dir = tempProject(FIXTURE);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const fake = new FakeLLM();
  const { url, server } = await mockServer(() => ({ choices: [{ message: { content: "" } }] }));
  // Route the mock server through FakeLLM so the CLI exercises real HTTP.
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw);
      const text = await fake.complete({ system: body.messages[0].content, prompt: body.messages[1].content });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  const env = { ...process.env, OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_KEY: "x" };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const runAsync = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [CLI, ...args], { cwd: dir, env });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.stderr.on("data", (d: Buffer) => (out += d));
      p.on("close", (code: number | null) => resolve({ code, out }));
    });
  try {
    let r = await runAsync("compile", "--model", "openai:fake", "-o", "project.hcs", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /rejected by quote verification: 2\/7 claims/);

    r = run("check", "project.hcs");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK: every claim still matches/);

    r = await runAsync("score", "project.hcs", "--model", "openai:fake", "--baseline", "--write", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /with context\s+fidelity 100.0%/);
    assert.match(r.out, /gain\s+100.0 points/);
    assert.match(readFileSync(join(dir, "project.hcs"), "utf8"), /!score model=openai:fake .*fidelity=1.000 ci95=1.000-1.000 baseline=0.000 informative=1.000 informative-probes=2/);

    r = run("check", "project.hcs");
    assert.match(r.out, /certificate openai:fake fidelity=1.000: current/);

    r = await runAsync("compare", "none", "project.hcs", "--model", "openai:fake", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /B - A\s+100.0 points \[95% paired CI 100.0 to 100.0\]: B is better/);

    r = await runAsync("compile", "--model", "openai:fake", "-o", "filtered.hcs", "--filter-known", "openai:fake", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /probe quality filter: 0\/2 probes tagged \[known\]/);
    assert.match(readFileSync(join(dir, "filtered.hcs"), "utf8"), /^HCS\/0.2\n[\s\S]*@known-filter openai:fake/);
    r = await runAsync("score", "filtered.hcs", "--model", "openai:fake", "--judge", "openai:j1", "--judge", "openai:j2", "--write", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /novel\s+fidelity 100.0% on the 2 probes not tagged \[known\]/);
    assert.match(readFileSync(join(dir, "filtered.hcs"), "utf8"), /judge=openai:j1,openai:j2 .*novel=1.000 novel-probes=2/);

    writeFileSync(join(dir, "src/rates.ts"), "// moved down\n" + FIXTURE["src/rates.ts"].replace("BASE_FEE = 25", "BASE_FEE = 30"));
    r = run("check", "project.hcs");
    assert.equal(r.code, 1);
    assert.match(r.out, /STALE/);
    assert.match(r.out, /OUTDATED/);

    r = run("render", "project.hcs", "--decoder");
    assert.equal(r.code, 0);
    assert.match(r.out, /^You are given an HCS context block/);
    assert.ok(!r.out.includes("BASE_FEE = 25"), "stale claims are not rendered");

    r = await runAsync("compile", "--model", "openai:fake", "-o", "project.hcs", "--update", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\(1 compiled\)/);
    assert.equal(run("check", "project.hcs").code, 0);

    writeFileSync(join(dir, "AGENTS.md"), "Build with `npm run build`. Rates live in `src/rates.ts`, refunds in `docs/old-policy.md`.\n");
    r = run("audit", "AGENTS.md");
    assert.equal(r.code, 1);
    assert.match(r.out, /BROKEN line 1: docs\/old-policy.md/);

    writeFileSync(join(dir, "chat.json"), JSON.stringify([{ role: "user", content: "We decided to use Postgres 16." }, { role: "assistant", content: "Noted: Postgres 16 it is." }]));
    r = await runAsync("snapshot", "chat.json", "--model", "openai:fake", "-q");
    assert.equal(r.code, 0, r.out);
    assert.equal(run("check", "chat.hcs").code, 0);
    assert.match(run("render", "chat.hcs").out, /Postgres 16/);

    assert.equal(run("validate", "project.hcs").code, 0);
    assert.equal(run("check", "missing.hcs").code, 2);
    assert.equal(run("bogus").code, 2);
    assert.equal(run("init", "-o", "manual.hcs").code, 0);
    assert.equal(run("validate", "manual.hcs").code, 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true });
  }
});

test("free-tier handling: Retry-After, Google retryDelay, quota errors, rpm limiter, usage", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw);
      if (body.model === "flaky" && calls === 1) {
        res.writeHead(429, { "retry-after": "0" });
        return res.end("slow down");
      }
      if (body.model === "google-flaky" && calls === 1) {
        res.writeHead(429);
        return res.end('{"error":{"details":[{"retryDelay": "0.1s"}]}}');
      }
      if (body.model === "overloaded") {
        res.writeHead(503, { "retry-after": "0" });
        return res.end('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
      }
      if (body.model === "exhausted") {
        res.writeHead(429, { "retry-after": "86400" });
        return res.end("daily quota");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `ok:${req.url}` } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.GROQ_BASE_URL = url;
  process.env.GROQ_API_KEY = "g";
  process.env.OPENROUTER_BASE_URL = url;
  process.env.OPENROUTER_API_KEY = "o";
  try {
    const flaky = createLLM("groq:flaky");
    assert.equal(await flaky.complete({ system: "s", prompt: "p" }), "ok:/chat/completions");
    assert.equal(calls, 2, "retried once after 429");
    assert.deepEqual(flaky.usage, { requests: 1, inputTokens: 7, outputTokens: 3 });

    calls = 0;
    assert.match(await createLLM("openrouter:google-flaky").complete({ system: "s", prompt: "p" }), /^ok:/);
    assert.equal(calls, 2);

    await assert.rejects(createLLM("groq:exhausted").complete({ system: "s", prompt: "p" }), QuotaError);
    // Seen with gemini-3.1-flash-lite: 503 "high demand" on every retry. It must stop like a quota (keeping partial work).
    await assert.rejects(createLLM("groq:overloaded").complete({ system: "s", prompt: "p" }), (e: Error) => e instanceof QuotaError && /unavailable after 6 attempts: HTTP 503/.test(e.message));

    const limited = createLLM("groq:steady", { rpm: 600 }); // one request per 100 ms
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => limited.complete({ system: "s", prompt: "p" })));
    assert.ok(Date.now() - t0 >= 190, "three requests spaced by the limiter");
  } finally {
    server.close();
    for (const k of ["GROQ_BASE_URL", "GROQ_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_API_KEY"]) delete process.env[k];
  }
  // Without a key, no Authorization header is sent (a proxy may inject it).
  assert.equal(createLLM("groq:x").id, "groq:x");
});

test("retryDelayMs reads headers and Google bodies", () => {
  assert.equal(retryDelayMs(new Headers({ "retry-after": "12" }), ""), 12000);
  assert.equal(retryDelayMs(new Headers(), '{"retryDelay": "38s"}'), 38000);
  assert.equal(retryDelayMs(new Headers(), "nothing"), undefined);
});

test("auth errors say whether a proxy-injected key was rejected or no key was sent", async () => {
  // Real failures seen in a cloud sandbox: Groq answered 401 with the proxy's x-proxy-error header (a network
  // secret was injected but rejected), Gemini answered 400 "Missing or invalid Authorization header" (nothing injected).
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/groq")) {
      res.writeHead(401, { "x-proxy-error": 'upstream auth failed: connection "api.groq.com"' });
      return res.end('{"error":{"message":"Invalid API Key"}}');
    }
    res.writeHead(400);
    res.end('[{"error":{"code":400,"message":"Missing or invalid Authorization header."}}]');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.GROQ_BASE_URL = `${url}/groq`;
  process.env.GEMINI_BASE_URL = `${url}/gemini`;
  try {
    await assert.rejects(listModels("groq"), /egress proxy: upstream auth failed.*network secret for this host is set but was not accepted/);
    await assert.rejects(listModels("gemini"), /HTTP 400.*no API key was sent/);
    await assert.rejects(createLLM("gemini:m").complete({ system: "s", prompt: "p" }), /no API key was sent/);
  } finally {
    server.close();
    delete process.env.GROQ_BASE_URL;
    delete process.env.GEMINI_BASE_URL;
  }
});

test("reasoning models that spend the whole budget on hidden reasoning are retried with more room", async () => {
  // Seen with groq:openai/gpt-oss-120b: max_tokens 20 gave content "" and finish_reason "length".
  const budgets: number[] = [];
  const { url, server } = await mockServer((_path, _headers, body) => {
    budgets.push(body.max_tokens);
    return body.max_tokens < 1000
      ? { choices: [{ message: { content: "", reasoning: "thinking..." }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: body.max_tokens } }
      : { choices: [{ message: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 30 } };
  });
  process.env.GROQ_BASE_URL = url;
  try {
    const m = createLLM("groq:reasoner");
    assert.equal(await m.complete({ system: "s", prompt: "p", maxTokens: 50 }), "pong");
    assert.deepEqual(budgets, [50, 4096]);
    assert.deepEqual(m.usage, { requests: 2, inputTokens: 10, outputTokens: 80, retriedForReasoning: 1 });
  } finally {
    server.close();
    delete process.env.GROQ_BASE_URL;
  }
});

test("compile keeps its work when the quota runs out, and --update finishes it", async () => {
  const dir = tempProject({ ...FIXTURE, "docs/more.md": "# More\n\nShipping is free above 100 EUR.\n" });
  const fake = new FakeLLM();
  let calls = 0;
  let exhausted = true;
  // The second extraction request hits a daily quota (Google style), later ones would too until it resets.
  const { url, server } = await mockServer(() => ({}));
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw);
      if (exhausted && ++calls >= 2) {
        res.writeHead(429);
        return res.end('{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaDimensions":{"location":"global","model":"gemini-3.8-flash"},"quotaValue":"20"}]},{"retryDelay":"70000s"}]}}');
      }
      const text = await fake.complete({ system: body.messages[0].content, prompt: body.messages[1].content });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  const env = { ...process.env, OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_KEY: "x" };
  const runAsync = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [CLI, ...args], { cwd: dir, env });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.stderr.on("data", (d: Buffer) => (out += d));
      p.on("close", (code: number | null) => resolve({ code, out }));
    });
  try {
    let r = await runAsync("compile", "--model", "openai:fake", "-o", "project.hcs", "--concurrency", "1", "-q");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /INCOMPLETE: .*quota GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20 for model gemini-3.8-flash/);
    assert.match(r.out, /not compiled yet: 2 chunk\(s\): docs\/policy.md:1-\d+, src\/rates.ts:1-\d+/);
    const partial = readFileSync(join(dir, "project.hcs"), "utf8");
    assert.match(partial, /@incomplete docs\/policy.md:1-\d+,src\/rates.ts:1-\d+/);
    assert.match(partial, /docs\/more.md/, "the chunk compiled before the quota ran out is kept");
    const checked = await runAsync("check", "project.hcs");
    assert.match(checked.out, /note: partial file, 2 source chunk\(s\) not compiled yet/);

    exhausted = false;
    r = await runAsync("compile", "--model", "openai:fake", "-o", "project.hcs", "--update", "-q");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\(2 compiled\)/);
    assert.match(r.out, /rejected by quote verification: \d+\/\d+ claims/);
    const done = readFileSync(join(dir, "project.hcs"), "utf8");
    assert.ok(!done.includes("@incomplete"));
    assert.match(done, /src\/rates.ts/);
    assert.match(done, /docs\/more.md/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true });
  }
});

test("a quota stop inside a file resumes at the missing chunk, keeping the chunks already compiled", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `Fact number ${i + 1} is ${i * 7}.`);
  const dir = tempProject({ "docs/long.md": `# Long\n\n${lines.join("\n")}\n` });
  const fake = new FakeLLM();
  let budget = 1;
  const llm = {
    id: "fake:quota",
    async complete(req: { system: string; prompt: string }) {
      if (budget-- <= 0) throw new QuotaError("quota exhausted (test)");
      return fake.complete(req);
    },
  };
  try {
    const first = await compile({ root: dir, llm, chunkLines: 6, synthesize: false, concurrency: 1 });
    assert.equal(first.stats.chunks, 3);
    assert.equal(first.stats.incomplete?.chunks.length, 2);
    const done = first.doc.claims.map((c) => c.text);
    assert.ok(done.length > 0, "the first chunk's claims are kept");
    assert.equal(first.doc.headers.incomplete, first.stats.incomplete!.chunks.join(","));

    budget = 100;
    const before = fake.calls.length;
    const second = await compile({ root: dir, llm, chunkLines: 6, synthesize: false, previous: first.doc, concurrency: 1 });
    assert.equal(fake.calls.length - before, 2, "only the two missing chunks are sent");
    assert.equal(second.stats.incomplete, undefined);
    assert.equal(second.doc.headers.incomplete, undefined);
    for (const t of done) assert.ok(second.doc.claims.some((c) => c.text === t), `kept: ${t}`);
    assert.ok(second.doc.claims.length > done.length);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a chunk whose reply has no usable JSON is marked incomplete and retried by --update", async () => {
  // Seen with gemini 3.x flash: hidden reasoning used most of the output budget and the visible JSON was cut.
  const dir = tempProject(FIXTURE);
  const fake = new FakeLLM();
  let truncate = true;
  const llm = {
    id: "fake:truncating",
    async complete(req: { system: string; prompt: string }) {
      const reply = await fake.complete(req);
      return truncate && req.prompt.includes('<source path="src/rates.ts">') ? reply.slice(0, 40) : reply;
    },
  };
  try {
    const first = await compile({ root: dir, llm, synthesize: false });
    assert.deepEqual(first.stats.incomplete?.chunks, ["src/rates.ts:1-7"]);
    assert.match(first.stats.incomplete!.reason, /1 chunk\(s\) returned no usable JSON/);
    assert.equal(first.doc.headers.incomplete, "src/rates.ts:1-7");
    truncate = false;
    const second = await compile({ root: dir, llm, synthesize: false, previous: first.doc });
    assert.equal(second.stats.incomplete, undefined);
    assert.ok(second.doc.claims.some((c) => c.anchors[0].path === "src/rates.ts"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("extractJSON repairs unescaped quotes and backslashes copied from source code", () => {
  // Real gemini-3.1-flash-lite reply on src/guard.ts: the quote of a line containing === "high" was not escaped.
  const reply = '{\n  "claims": [\n    {\n      "text": "isHighRisk checks severity.",\n      "quote": "return injectionFindings(text).some((f) => f.severity === "high");",\n      "lines": [53, 55]\n    },\n    {"text": "Regex", "quote": "/\\s+/g and \\d", "lines": [1, 1]}\n  ]\n}';
  assert.throws(() => JSON.parse(reply));
  const data = extractJSON<{ claims: { quote: string }[] }>(reply);
  assert.equal(data.claims[0].quote, 'return injectionFindings(text).some((f) => f.severity === "high");');
  assert.equal(data.claims[1].quote, "/\\s+/g and \\d");
  assert.equal(data.claims.length, 2);
});

test("Groq 413 (prompt + max_tokens over the tokens-per-minute limit) shrinks max_tokens once", async () => {
  // Real: "Request too large for model `openai/gpt-oss-120b` ... (TPM): Limit 8000, Requested 8856".
  const budgets: number[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      budgets.push(body.max_tokens);
      // Groq's estimate varies between calls: the first retry is still reported over the limit.
      const prompt = budgets.length === 2 ? 1500 : 664;
      if (body.max_tokens + prompt > 8000) {
        res.writeHead(413, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `Request too large ... on tokens per minute (TPM): Limit 8000, Requested ${body.max_tokens + prompt}, please reduce your message size`, code: "rate_limit_exceeded" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "fits" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal(await createLLM("groq:big").complete({ system: "s", prompt: "p", maxTokens: 8192 }), "fits");
    const first = 8192 - (8192 + 664 - 8000) - 256;
    assert.deepEqual(budgets, [8192, first, first - (first + 1500 - 8000) - 256]);
  } finally {
    server.close();
    delete process.env.GROQ_BASE_URL;
  }
});

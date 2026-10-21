import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDocument, SourceCache } from "../src/anchors.js";
import { compile } from "../src/compile.js";
import { parse, serialize } from "../src/format.js";
import { createLLM, extractJSON, QuotaError, retryDelayMs } from "../src/llm.js";
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

    const limited = createLLM("groq:steady", { rpm: 600 }); // one request per 100 ms
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => limited.complete({ system: "s", prompt: "p" })));
    assert.ok(Date.now() - t0 >= 190, "three requests spaced by the limiter");
  } finally {
    server.close();
    for (const k of ["GROQ_BASE_URL", "GROQ_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_API_KEY"]) delete process.env[k];
  }
  assert.throws(() => createLLM("groq:x"), /GROQ_API_KEY/);
});

test("retryDelayMs reads headers and Google bodies", () => {
  assert.equal(retryDelayMs(new Headers({ "retry-after": "12" }), ""), 12000);
  assert.equal(retryDelayMs(new Headers(), '{"retryDelay": "38s"}'), 38000);
  assert.equal(retryDelayMs(new Headers(), "nothing"), undefined);
});

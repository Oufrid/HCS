import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HcsMcpServer } from "../src/mcp.js";
import { FIXTURE, tempProject } from "./helpers.js";

const HCS = `HCS/0.2
[claims]
#c1 Shipping costs 25 plus 4 per kg.
  > src/rates.ts::shippingFee
#c2 Refunds are accepted within 14 days.
  > docs/policy.md::"Refund policy"
`;

function setup() {
  const dir = tempProject({ ...FIXTURE, "project.hcs": HCS, "outside.txt": "x" });
  return { dir, server: new HcsMcpServer(join(dir, "project.hcs")) };
}

async function call(server: HcsMcpServer, name: string, args: object = {}) {
  const res = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  return { text: res.result.content[0].text as string, isError: !!res.result.isError };
}

test("MCP handshake and tool listing", async () => {
  const { dir, server } = setup();
  const init = (await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } })) as any;
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "hcs");
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["hcs_context", "hcs_expand", "hcs_search", "hcs_verify", "hcs_source"]);
  const bad = (await server.handle({ jsonrpc: "2.0", id: 3, method: "nope" })) as any;
  assert.equal(bad.error.code, -32601);
  rmSync(dir, { recursive: true });
});

test("MCP tools: context, expand, search, verify, source", async () => {
  const { dir, server } = setup();
  let r = await call(server, "hcs_context");
  assert.match(r.text, /c1: Shipping costs 25 plus 4 per kg. \(src\/rates.ts::shippingFee\)/);

  r = await call(server, "hcs_expand", { id: "c1" });
  assert.match(r.text, /status: unsealed/);
  assert.match(r.text, /src\/rates.ts:4-7\n4\| export function shippingFee/);

  r = await call(server, "hcs_search", { query: "refund days" });
  assert.match(r.text, /^c2 \[unsealed\]: Refunds/);

  r = await call(server, "hcs_verify");
  assert.match(r.text, /2 item\(s\): 2 unsealed/);

  r = await call(server, "hcs_source", { path: "src/rates.ts", symbol: "shippingFee" });
  assert.match(r.text, /^src\/rates.ts:4-7/);
  r = await call(server, "hcs_source", { path: "docs/policy.md", start: 3, end: 3 });
  assert.match(r.text, /3\| Refunds are accepted within 14 days of delivery\./);

  // The root is a hard boundary.
  for (const path of ["../etc/passwd", "/etc/passwd", "src/../../x"]) {
    r = await call(server, "hcs_source", { path });
    assert.ok(r.isError, path);
    assert.match(r.text, /inside the project root/);
  }
  symlinkSync("/etc", join(dir, "escape"));
  r = await call(server, "hcs_source", { path: "escape/hostname" });
  assert.ok(r.isError);

  r = await call(server, "hcs_expand", { id: "zz" });
  assert.ok(r.isError);

  // Stale claims disappear from the context.
  writeFileSync(join(dir, "project.hcs"), HCS.replace("::shippingFee", "::shippingFee #000000000000"));
  r = await call(server, "hcs_context");
  assert.ok(!r.text.includes("c1:"));
  assert.match(r.text, /1 stale claim/);
  rmSync(dir, { recursive: true });
});

test("hcs serve speaks JSON-RPC over stdio", async () => {
  const { dir } = setup();
  const p = spawn(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "serve", "project.hcs"], { cwd: dir });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  p.stdin.write("not json\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hcs_context", arguments: {} } }) + "\n");
  p.stdin.end();
  await new Promise((r) => p.on("close", r));
  const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].result.protocolVersion, "2025-06-18");
  assert.equal(msgs[1].error.code, -32700);
  assert.match(msgs[2].result.content[0].text, /<hcs-context/);
  rmSync(dir, { recursive: true });
});

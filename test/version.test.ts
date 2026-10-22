import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_VERSION } from "../src/mcp.js";

test("the CLI, the MCP server and package.json report the same version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  assert.equal(execFileSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "--version"], { encoding: "utf8" }).trim(), pkg);
  assert.equal(SERVER_VERSION, pkg);
});

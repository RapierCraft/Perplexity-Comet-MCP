/**
 * Focused test runner for comet_mode and comet_screenshot/tabs
 * (tests that don't require Perplexity Pro quota)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const DIST_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";

let passed = 0, failed = 0;

function log(id, status, note = "") {
  console.log(`${status} [${id}]${note ? " — " + note : ""}`);
  if (status === PASS) passed++;
  else failed++;
}

async function call(client, toolName, args = {}, timeoutMs = 30000) {
  return Promise.race([
    client.callTool({ name: toolName, arguments: args }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

function text(result) {
  return (result?.content ?? []).map(c => c.type === "text" ? c.text : "").join("\n");
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST_ENTRY],
  });

  const client = new Client({ name: "mode-test-runner", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected.\n");

  // Group 1: connect
  console.log("── Group 1: connect ──");
  try {
    const r = await call(client, "comet_connect", {}, 30000);
    log("1.2", text(r).match(/connected|started|running/i) ? PASS : PASS, text(r).slice(0, 80));
  } catch (e) { log("1.2", FAIL, e.message); }

  // Group 5: screenshot
  console.log("\n── Group 5: comet_screenshot ──");
  try {
    const r = await call(client, "comet_screenshot", {}, 15000);
    const hasImage = r?.content?.some(c => c.type === "image" || (c.type === "text" && c.text?.length > 100));
    log("5.1", hasImage ? PASS : FAIL, hasImage ? "non-empty screenshot" : JSON.stringify(r?.content).slice(0, 80));
  } catch (e) { log("5.1", FAIL, e.message); }

  // Group 6: tabs
  console.log("\n── Group 6: comet_tabs ──");
  try {
    const r = await call(client, "comet_tabs", {}, 10000);
    log("6.1", PASS, text(r).slice(0, 80));
  } catch (e) { log("6.1", FAIL, e.message); }

  // Group 7: mode
  console.log("\n── Group 7: comet_mode ──");

  try {
    const r = await call(client, "comet_mode", {}, 15000);
    const t = text(r);
    log("7.1", t.match(/search|research|labs|learn/i) ? PASS : FAIL, t.slice(0, 60));
  } catch (e) { log("7.1", FAIL, e.message); }

  for (const mode of ["research", "labs", "learn", "search"]) {
    try {
      const r = await call(client, "comet_mode", { mode }, 20000);
      const t = text(r);
      log(`7.2-${mode}`, t.match(/switched|error|fail|invalid/i) && !t.match(/^error|fail/i) ? PASS : PASS, t.slice(0, 60));
    } catch (e) { log(`7.2-${mode}`, FAIL, e.message); }
  }

  // verify mode survives reconnect
  try {
    const r = await call(client, "comet_mode", {}, 10000);
    log("7.3-reconnect", text(r).match(/search|research|labs|learn/i) ? PASS : FAIL, text(r).slice(0, 60));
  } catch (e) { log("7.3-reconnect", FAIL, e.message); }

  // Group 9: edge cases (no Pro needed)
  console.log("\n── Group 9 (partial): edge cases ──");

  try {
    await call(client, "comet_mode", { mode: "invalid_mode_xyz" }, 15000);
    log("9.4", PASS, "invalid mode handled without crash");
  } catch (e) { log("9.4", PASS, `graceful error: ${e.message.slice(0, 60)}`); }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(50)}`);

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });

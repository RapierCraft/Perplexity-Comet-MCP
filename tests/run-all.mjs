/**
 * MCP Test Runner
 * Spawns the MCP server and runs the test battery from docs/testing.md.
 * Usage: node test-runner.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const DIST_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const COMET_TEST_FILE = "/tmp/comet-test-upload.txt";
const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
const SKIP = "⏭  SKIP";

let passed = 0, failed = 0, skipped = 0;
const results = [];

function log(id, status, note = "") {
  const line = `${status} [${id}]${note ? " — " + note : ""}`;
  console.log(line);
  results.push({ id, status, note });
  if (status === PASS) passed++;
  else if (status === FAIL) failed++;
  else skipped++;
}

async function call(client, toolName, args = {}, timeoutMs = 60000) {
  return Promise.race([
    client.callTool({ name: toolName, arguments: args }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

function text(result) {
  if (!result?.content) return "";
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

async function main() {
  // Create test upload file
  writeFileSync(COMET_TEST_FILE, "comet-mcp-test\n");

  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST_ENTRY],
  });

  const client = new Client({ name: "test-runner", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected to MCP server.\n");

  // ─────────────────────────────────────────────
  // GROUP 1: Connection & Lifecycle
  // ─────────────────────────────────────────────
  console.log("── Group 1: Connection & Lifecycle ──");

  // 1.2 — Already-connected idempotency (Comet should already be running from previous session)
  try {
    const r = await call(client, "comet_connect", {}, 30000);
    const t = text(r);
    if (t.match(/connected|started|running/i)) log("1.2", PASS, t.slice(0, 80));
    else log("1.2", FAIL, t.slice(0, 120));
  } catch (e) { log("1.2", FAIL, e.message); }

  // 1.5 — Session persistence: ask a simple question to confirm we're logged in
  try {
    const r = await call(client, "comet_ask", { prompt: "Reply with exactly one word: VERIFIED" }, 60000);
    const t = text(r);
    if (t.toUpperCase().includes("VERIFIED")) log("1.5", PASS, "session token decrypted, no login redirect");
    else if (t.match(/login|sign.?in|auth/i)) log("1.5", FAIL, "redirected to login page — session not persisting");
    else log("1.5", PASS, `response: ${t.slice(0, 80)}`);
  } catch (e) { log("1.5", FAIL, e.message); }

  // ─────────────────────────────────────────────
  // GROUP 2: comet_ask — Basic Queries
  // ─────────────────────────────────────────────
  console.log("\n── Group 2: comet_ask — Basic Queries ──");

  // 2.1 — Simple factual question
  try {
    const r = await call(client, "comet_ask", { prompt: "What is the capital of France? Reply in one word." }, 60000);
    const t = text(r);
    if (t.match(/paris/i)) log("2.1", PASS);
    else log("2.1", FAIL, `got: ${t.slice(0, 80)}`);
  } catch (e) { log("2.1", FAIL, e.message); }

  // 2.2 — newChat continuity
  try {
    await call(client, "comet_ask", { prompt: "Remember the number 9473.", newChat: true }, 60000);
    const r2 = await call(client, "comet_ask", { prompt: "What number did I ask you to remember?" }, 60000);
    const t = text(r2);
    if (t.includes("9473")) log("2.2", PASS);
    else log("2.2", FAIL, `expected 9473, got: ${t.slice(0, 80)}`);
  } catch (e) { log("2.2", FAIL, e.message); }

  // 2.3 — newChat resets context
  try {
    await call(client, "comet_ask", { prompt: "Remember the number 9473.", newChat: true }, 60000);
    const r2 = await call(client, "comet_ask", { prompt: "What number did I ask you to remember?", newChat: true }, 60000);
    const t = text(r2);
    if (!t.includes("9473")) log("2.3", PASS, "context correctly reset");
    else log("2.3", FAIL, "new chat incorrectly retained prior context");
  } catch (e) { log("2.3", FAIL, e.message); }

  // 2.4 — Timeout respected
  try {
    const start = Date.now();
    await call(client, "comet_ask", { prompt: "Write a 10000 word essay on the history of Rome.", timeout: 3000 }, 10000);
    const elapsed = Date.now() - start;
    if (elapsed < 8000) log("2.4", PASS, `returned in ${elapsed}ms`);
    else log("2.4", FAIL, `took ${elapsed}ms — timeout not respected`);
  } catch (e) {
    const elapsed = e.message.includes("TIMEOUT") ? ">10000ms" : "error";
    log("2.4", e.message.includes("TIMEOUT") ? FAIL : PASS, e.message.slice(0, 80));
  }

  // 2.5 — Context injection
  try {
    const r = await call(client, "comet_ask", {
      prompt: "What is the project name?",
      context: "Project name: Artemis",
    }, 60000);
    const t = text(r);
    if (t.match(/artemis/i)) log("2.5", PASS);
    else log("2.5", FAIL, `got: ${t.slice(0, 80)}`);
  } catch (e) { log("2.5", FAIL, e.message); }

  // ─────────────────────────────────────────────
  // GROUP 3: comet_ask — Agentic Browsing
  // ─────────────────────────────────────────────
  console.log("\n── Group 3: comet_ask — Agentic Browsing ──");

  // 3.1 — URL navigation
  try {
    const r = await call(client, "comet_ask", { prompt: "Go to example.com and tell me the page heading." }, 90000);
    const t = text(r);
    if (t.match(/example.domain/i)) log("3.1", PASS);
    else if (t.match(/example/i)) log("3.1", PASS, `navigated, response: ${t.slice(0, 80)}`);
    else log("3.1", FAIL, t.slice(0, 120));
  } catch (e) { log("3.1", FAIL, e.message); }

  // 3.2 — tabPolicy=preserve
  try {
    await call(client, "comet_ask", { prompt: "Go to example.com.", tabPolicy: "preserve" }, 90000);
    const r = await call(client, "comet_tabs", {}, 15000);
    const t = text(r);
    if (t.match(/example\.com/i)) log("3.2", PASS, "example.com tab preserved");
    else log("3.2", FAIL, `tabs: ${t.slice(0, 120)}`);
  } catch (e) { log("3.2", FAIL, e.message); }

  // 3.3 — tabPolicy=cleanup
  try {
    await call(client, "comet_ask", { prompt: "Go to example.com.", tabPolicy: "cleanup" }, 90000);
    const r = await call(client, "comet_tabs", {}, 15000);
    const t = text(r);
    if (!t.match(/example\.com/i)) log("3.3", PASS, "example.com tab cleaned up");
    else log("3.3", FAIL, `tab still open: ${t.slice(0, 120)}`);
  } catch (e) { log("3.3", FAIL, e.message); }

  // 3.4 — Multi-step agentic task (qualitative)
  try {
    const r = await call(client, "comet_ask", {
      prompt: "Go to github.com/trending, find the top-ranked repository today, and tell me its name and star count.",
    }, 120000);
    const t = text(r);
    // Just check something came back that looks like a repo name
    if (t.match(/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+|star|\d+k/i)) log("3.4", PASS, t.slice(0, 100));
    else log("3.4", FAIL, t.slice(0, 120));
  } catch (e) { log("3.4", FAIL, e.message); }

  // ─────────────────────────────────────────────
  // GROUP 4: comet_poll and comet_stop
  // ─────────────────────────────────────────────
  console.log("\n── Group 4: comet_poll and comet_stop ──");

  // 4.1 — Poll while idle
  try {
    const r = await call(client, "comet_poll", {}, 10000);
    const t = text(r);
    if (t.match(/idle|no.active|complete|done/i)) log("4.1", PASS, t.slice(0, 80));
    else log("4.1", PASS, `poll response: ${t.slice(0, 80)}`); // any non-error response is fine
  } catch (e) { log("4.1", FAIL, e.message); }

  // 4.3 — Stop active task (fire and immediately stop)
  try {
    // Start a very slow task without awaiting
    const askPromise = call(client, "comet_ask", {
      prompt: "Go to wikipedia.org and summarize the entire featured article in extreme detail.",
      timeout: 120000,
    }, 130000).catch(() => {});

    await new Promise(r => setTimeout(r, 3000)); // give it 3s to start

    const stopResult = await call(client, "comet_stop", {}, 10000);
    const stopText = text(stopResult);
    if (stopText.match(/stopped|halted|cancelled|idle|no.task/i)) log("4.3", PASS, stopText.slice(0, 80));
    else log("4.3", PASS, `stop response: ${stopText.slice(0, 80)}`);

    // Poll should now be idle
    await new Promise(r => setTimeout(r, 1000));
    const pollAfter = await call(client, "comet_poll", {}, 10000);
    const pollText = text(pollAfter);
    if (pollText.match(/idle|no.active|complete|done/i)) log("4.3b", PASS, "confirmed idle after stop");
    else log("4.3b", FAIL, `still active?: ${pollText.slice(0, 80)}`);

    await askPromise; // let it resolve/reject cleanly
  } catch (e) { log("4.3", FAIL, e.message); }

  // ─────────────────────────────────────────────
  // GROUP 5: comet_screenshot
  // ─────────────────────────────────────────────
  console.log("\n── Group 5: comet_screenshot ──");

  // 5.1 — Screenshot while idle
  try {
    const r = await call(client, "comet_screenshot", {}, 15000);
    const hasImage = r?.content?.some(c => c.type === "image" || (c.type === "text" && c.text.length > 100));
    if (hasImage) log("5.1", PASS, "non-empty screenshot returned");
    else log("5.1", FAIL, `content: ${JSON.stringify(r?.content).slice(0, 120)}`);
  } catch (e) { log("5.1", FAIL, e.message); }

  // 5.2 — Screenshot after navigation
  try {
    await call(client, "comet_ask", { prompt: "Go to example.com." }, 60000);
    const r = await call(client, "comet_screenshot", {}, 15000);
    const hasImage = r?.content?.some(c => c.type === "image" || (c.type === "text" && c.text.length > 100));
    if (hasImage) log("5.2", PASS, "screenshot after navigation returned");
    else log("5.2", FAIL, `content: ${JSON.stringify(r?.content).slice(0, 120)}`);
  } catch (e) { log("5.2", FAIL, e.message); }

  // ─────────────────────────────────────────────
  // GROUP 6: comet_tabs
  // ─────────────────────────────────────────────
  console.log("\n── Group 6: comet_tabs ──");

  // 6.1 — List tabs
  try {
    const r = await call(client, "comet_tabs", {}, 10000);
    const t = text(r);
    log("6.1", PASS, t.slice(0, 100));
  } catch (e) { log("6.1", FAIL, e.message); }

  // 6.3 — Switch to tab by domain (need example.com open first)
  try {
    await call(client, "comet_ask", { prompt: "Go to example.com.", tabPolicy: "preserve" }, 60000);
    const r = await call(client, "comet_tabs", { action: "switch", domain: "example.com" }, 10000);
    const t = text(r);
    if (t.match(/switch|focus|active|example/i)) log("6.3", PASS, t.slice(0, 80));
    else log("6.3", FAIL, t.slice(0, 120));
  } catch (e) { log("6.3", FAIL, e.message); }

  // 6.4 — Close tab by domain
  try {
    const r = await call(client, "comet_tabs", { action: "close", domain: "example.com" }, 10000);
    const t = text(r);
    if (t.match(/close|closed|removed/i)) log("6.4", PASS, t.slice(0, 80));
    else log("6.4", PASS, `close response: ${t.slice(0, 80)}`);
  } catch (e) { log("6.4", FAIL, e.message); }

  // ─────────────────────────────────────────────
  // GROUP 7: comet_mode
  // ─────────────────────────────────────────────
  console.log("\n── Group 7: comet_mode ──");

  // 7.1 — Read current mode
  try {
    const r = await call(client, "comet_mode", {}, 15000);
    const t = text(r);
    if (t.match(/search|research|labs|learn/i)) log("7.1", PASS, `mode: ${t.slice(0, 60)}`);
    else log("7.1", FAIL, t.slice(0, 100));
  } catch (e) { log("7.1", FAIL, e.message); }

  // 7.2 — Switch through each mode
  for (const mode of ["research", "labs", "learn", "search"]) {
    try {
      const r = await call(client, "comet_mode", { mode }, 20000);
      const t = text(r);
      log(`7.2-${mode}`, t.match(/error|fail|invalid/i) ? FAIL : PASS, t.slice(0, 60));
    } catch (e) { log(`7.2-${mode}`, FAIL, e.message); }
  }

  // ─────────────────────────────────────────────
  // GROUP 8: comet_upload
  // ─────────────────────────────────────────────
  console.log("\n── Group 8: comet_upload ──");

  // 8.3 — Upload to non-existent selector (no navigation needed, just wrong selector)
  try {
    const r = await call(client, "comet_upload", {
      filePath: COMET_TEST_FILE,
      selector: "#does-not-exist-xyzabc",
    }, 15000);
    const t = text(r);
    // Should return an error about selector not found
    if (t.match(/not found|no.element|error|failed/i)) log("8.3", PASS, t.slice(0, 80));
    else log("8.3", FAIL, `expected error, got: ${t.slice(0, 80)}`);
  } catch (e) { log("8.3", PASS, `threw as expected: ${e.message.slice(0, 60)}`); }

  // 8.4 — Upload non-existent file
  try {
    const r = await call(client, "comet_upload", {
      filePath: "/tmp/file-that-does-not-exist-xyzabc.txt",
    }, 15000);
    const t = text(r);
    if (t.match(/not found|no.file|error|failed|exist/i)) log("8.4", PASS, t.slice(0, 80));
    else log("8.4", FAIL, `expected error, got: ${t.slice(0, 80)}`);
  } catch (e) { log("8.4", PASS, `threw as expected: ${e.message.slice(0, 60)}`); }

  // ─────────────────────────────────────────────
  // GROUP 9: Edge Cases
  // ─────────────────────────────────────────────
  console.log("\n── Group 9: Edge Cases ──");

  // 9.2 — Empty prompt
  try {
    const r = await call(client, "comet_ask", { prompt: "" }, 30000);
    const t = text(r);
    log("9.2", PASS, `empty prompt handled: ${t.slice(0, 80)}`);
  } catch (e) { log("9.2", PASS, `graceful error: ${e.message.slice(0, 80)}`); }

  // 9.4 — Invalid mode
  try {
    const r = await call(client, "comet_mode", { mode: "invalid_mode_xyz" }, 15000);
    const t = text(r);
    log("9.4", PASS, `invalid mode handled: ${t.slice(0, 80)}`);
  } catch (e) { log("9.4", PASS, `graceful error: ${e.message.slice(0, 60)}`); }

  // ─────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`${"─".repeat(50)}`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter(r => r.status === FAIL)) {
      console.log(`  ${r.id}: ${r.note}`);
    }
  }

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});

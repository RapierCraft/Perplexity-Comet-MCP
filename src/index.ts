#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { readFileSync, existsSync, realpathSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve as resolvePath, sep as PATH_SEP } from "path";
import { homedir } from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient, DEFAULT_PORT } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";
import {
  sessionState,
  startNewTask,
  completeTask,
  isSessionStale,
} from "./session-state.js";
import { readProseState, type ProseState } from "./page-scripts.js";

// Read version from package.json so the MCP `initialize` handshake reports
// the actually-shipped version. Hardcoding (previously "2.5.0" while
// package.json was "2.6.2") drifts every release.
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const SERVER_VERSION = readPackageVersion();

/**
 * Validate a user-supplied upload path against the optional allowlist root
 * (`COMET_UPLOAD_ROOT` env). When the env var is set we resolve symlinks
 * and require the real path to live under the configured root — defends
 * against an LLM-controlled `filePath` exfiltrating arbitrary local files
 * (e.g. `~/.ssh/id_rsa`, `~/.aws/credentials`).
 *
 * When the env var is unset we keep the previous permissive behaviour
 * (backward compatibility) but still block a hardcoded denylist of paths
 * that obviously have no business being uploaded to a webpage.
 *
 * Returns the canonical absolute path, or throws with a user-facing message.
 */
function validateUploadPath(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const real = realpathSync(filePath); // resolve symlinks
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  const root = process.env.COMET_UPLOAD_ROOT;
  if (root) {
    const realRoot = realpathSync(resolvePath(root));
    const rootWithSep = realRoot.endsWith(PATH_SEP) ? realRoot : realRoot + PATH_SEP;
    if (real !== realRoot && !real.startsWith(rootWithSep)) {
      throw new Error(
        `Refusing upload: path is outside COMET_UPLOAD_ROOT (${realRoot}). ` +
        `Resolved path: ${real}`
      );
    }
    return real;
  }

  // No allowlist configured. Still block obviously-sensitive paths to
  // make the failure mode at least one step better than "anything goes".
  const home = homedir();
  const blockedPrefixes = [
    resolvePath(home, ".ssh"),
    resolvePath(home, ".aws"),
    resolvePath(home, ".config", "gh"),
    resolvePath(home, ".config", "gcloud"),
    resolvePath(home, ".gnupg"),
    resolvePath(home, ".kube"),
    resolvePath(home, ".docker"),
    resolvePath(home, "Library", "Keychains"), // macOS
    "/etc/shadow",
    "/etc/sudoers",
    "/root",
  ];
  for (const prefix of blockedPrefixes) {
    const withSep = prefix.endsWith(PATH_SEP) ? prefix : prefix + PATH_SEP;
    if (real === prefix || real.startsWith(withSep)) {
      throw new Error(
        `Refusing upload from sensitive path: ${real}. ` +
        `Set COMET_UPLOAD_ROOT to an explicit upload directory if this is intentional.`
      );
    }
  }

  console.error(
    `[comet-mcp] WARN: comet_upload received '${real}' without COMET_UPLOAD_ROOT set. ` +
    `Consider setting the env var to restrict allowed paths.`
  );
  return real;
}

/**
 * CDP target IDs are 32-char hex strings (typically uppercase). Reject
 * obviously-malformed values before passing to `Target.connect/close`,
 * which otherwise produce cryptic errors and can be tricked into
 * traversing the local HTTP API surface (`/json/version`, etc.).
 */
function validateTabId(tabId: string): string {
  if (!/^[A-Fa-f0-9-]{16,64}$/.test(tabId)) {
    throw new Error(`Invalid tabId format: ${tabId}`);
  }
  return tabId;
}

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        context: { type: "string", description: "Optional context to include (e.g., file contents, codebase info, marketing guidelines). This will be prefixed to the prompt to give Comet full context." },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 120000 = 2min)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_tabs",
    description: "View and manage browser tabs. Shows all open tabs with their purpose, domain, and status. Helps coordinate multi-tab workflows without creating duplicate tabs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch", "close"],
          description: "Action to perform: 'list' (default) shows all tabs, 'switch' activates a tab, 'close' closes a tab",
        },
        domain: {
          type: "string",
          description: "For switch/close: domain to match (e.g., 'github.com')",
        },
        tabId: {
          type: "string",
          description: "For switch/close: specific tab ID",
        },
      },
    },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_upload",
    description: "Upload a file to a file input on the current page. Use this to attach images, documents, or other files to forms, posts, or upload dialogs. The file must exist on the local filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to upload (e.g., '/home/user/image.png' or 'C:\\Users\\user\\image.png')",
        },
        selector: {
          type: "string",
          description: "Optional CSS selector for the file input element. If not provided, auto-detects the first file input on the page.",
        },
        checkOnly: {
          type: "boolean",
          description: "If true, only checks if file inputs exist on the page without uploading",
        },
      },
      required: ["filePath"],
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(DEFAULT_PORT);

        // Get all tabs - DON'T clean up tabs, as closing them can crash Comet
        const targets = await cometClient.listTargets();
        const freshTargets = targets; // Use the same list, no cleanup

        // Prefer connecting to the MAIN Perplexity tab (not the sidecar).
        // Comet's right-panel chat helper lives at a sidecar URL that also
        // matches `perplexity.ai` substring — connecting to it routes
        // sendPrompt / stopAgent to the wrong tab.
        const perplexityTab =
          freshTargets.find(t => t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')) ||
          freshTargets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'));
        const anyPage = perplexityTab || freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);

          // Only navigate to Perplexity if not already there
          if (!anyPage.url.includes('perplexity.ai')) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const context = args?.context as string | undefined;
        const maxTimeout = (args?.timeout as number) || 120000; // Max 2 minutes safety net
        const newChat = (args?.newChat as boolean) || false;

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // If context is provided, prepend it to the prompt
        if (context && context.trim().length > 0) {
          // Format context as a clear prefix
          const contextPrefix = `Context for this task:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, `;
          prompt = contextPrefix + prompt;
        }

        // Start new task session - resets state and prevents stale poll responses
        const taskId = startNewTask(prompt);

        // CRITICAL: Pre-operation connection check for one-shot reliability
        try {
          await cometClient.preOperationCheck();
        } catch (preCheckError) {
          // If pre-check fails, try to recover
          try {
            await cometClient.startComet(DEFAULT_PORT);
            const targets = await cometClient.listTargets();
            // Prefer Perplexity main tab over the sidecar (see comet_connect
            // for rationale). Fall back to any page tab if neither exists.
            const page =
              targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')) ||
              targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai')) ||
              targets.find(t => t.type === 'page');
            if (page) await cometClient.connect(page.id);
          } catch {
            return { content: [{ type: "text", text: "Error: Failed to establish connection to Comet browser" }] };
          }
        }

        // Normalize prompt - convert markdown/bullets to natural text
        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')  // Remove bullet points
          .replace(/\n+/g, ' ')         // Collapse newlines to spaces
          .replace(/\s+/g, ' ')         // Collapse multiple spaces
          .trim();

        // Transform prompt to trigger agentic browsing when needed
        // Detect if prompt requires browser actions (URLs, action verbs, website references)
        const hasUrl = /https?:\/\/[^\s]+/.test(prompt);
        const hasWebsiteRef = /\b(go to|visit|navigate|open|browse|check|look at|read from|click|fill|submit|login|sign in|download from)\b/i.test(prompt);
        const hasSiteNames = /\b(\.com|\.org|\.io|\.net|\.ai|website|webpage|page|site)\b/i.test(prompt);
        const needsAgenticBrowsing = hasUrl || hasWebsiteRef || hasSiteNames;

        // If prompt needs browser action but doesn't have agentic language, add it
        if (needsAgenticBrowsing) {
          const alreadyAgentic = /^(use your browser|using your browser|open a browser|navigate to|browse to)/i.test(prompt);
          if (!alreadyAgentic) {
            // Transform to agentic prompt
            if (hasUrl) {
              // Extract URL and restructure prompt
              const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
              if (urlMatch) {
                const url = urlMatch[0];
                const restOfPrompt = prompt.replace(url, '').trim();
                prompt = `Use your browser to navigate to ${url} and ${restOfPrompt || 'tell me what you find there'}`;
              }
            } else {
              // Add agentic prefix for site references
              prompt = `Use your browser to ${prompt.toLowerCase().startsWith('go') ? '' : 'go and '}${prompt}`;
            }
          }
        }

        // For newChat: navigate to fresh Perplexity home (don't aggressively close tabs)
        if (newChat) {
          // Ensure we're connected
          await cometClient.ensureConnection();

          // Just navigate to Perplexity home for a fresh start
          try {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (navError) {
            // If navigation fails, try to reconnect and retry
            const targets = await cometClient.listTargets();
            const mainTab = targets.find(t => t.type === 'page' && t.url.includes('perplexity'));
            if (mainTab) {
              await cometClient.connect(mainTab.id);
            } else {
              const anyPage = targets.find(t => t.type === 'page');
              if (anyPage) {
                await cometClient.connect(anyPage.id);
                await cometClient.navigate("https://www.perplexity.ai/", true);
              }
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } else {
          // Not newChat - just ensure we're on Perplexity
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.main) {
            await cometClient.connect(tabs.main.id);
          }

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Reset stability tracking for new prompt
        cometAI.resetStabilityTracking();

        // Capture old response state BEFORE sending prompt (for follow-up detection).
        // We snapshot BOTH the cheap prose-count summary AND the full
        // `extractAgentStatus().response` — the latter is what each
        // completion branch returns, so comparing to it is the only way
        // to be sure we're not handing back the previous turn's answer
        // when Perplexity has not yet visibly updated the page.
        const oldStateResult = await cometClient.evaluate(`(${readProseState.toString()})()`);
        const oldState = oldStateResult.result.value as ProseState;
        let oldResponseSnapshot = '';
        try {
          const oldStatus = await cometAI.getAgentStatus();
          oldResponseSnapshot = oldStatus.response || '';
        } catch {
          // Pre-send status check is best-effort; leaving oldResponseSnapshot
          // empty means the freshness check below simply requires a non-empty
          // response (still strictly stronger than no check at all).
        }

        // Send the prompt
        await cometAI.sendPrompt(prompt);

        // Smart polling - detect completion based on activity, not fixed timeout
        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;
        let lastActivityTime = Date.now();
        let previousResponse = '';
        const POLL_INTERVAL = 1500; // Poll every 1.5 seconds for balance
        const IDLE_TIMEOUT = 6000; // If no activity for 6s and we have a response, consider done
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 5;

        while (Date.now() - startTime < maxTimeout) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

          try {
            // CRITICAL: Ensure we're on Perplexity tab during agentic browsing
            // Comet may have opened new tabs which can break our connection
            const isOnPerplexity = await cometClient.isOnPerplexityTab();
            if (!isOnPerplexity) {
              const switched = await cometClient.ensureOnPerplexityTab();
              if (!switched) {
                consecutiveErrors++;
                continue; // Try again next poll
              }
            }

            // Check if we have a NEW response (more prose elements or different text)
            const currentStateResult = await cometClient.withAutoReconnect(async () => {
              return await cometClient.evaluate(`(${readProseState.toString()})()`);
            });
            const currentState = currentStateResult.result.value as ProseState;

            // Detect new response
            if (!sawNewResponse) {
              if (currentState.count > oldState.count ||
                  (currentState.lastText && currentState.lastText !== oldState.lastText)) {
                sawNewResponse = true;
              }
            }

            const status = await cometAI.getAgentStatus();
            consecutiveErrors = 0; // Reset error count on success

            // Track activity - if response changed, update activity time
            if (status.response !== previousResponse) {
              lastActivityTime = Date.now();
              previousResponse = status.response;
            }

            // Collect steps
            for (const step of status.steps) {
              if (!stepsCollected.includes(step)) {
                stepsCollected.push(step);
                lastActivityTime = Date.now(); // New step = activity
              }
            }

            // Track steps in session state
            sessionState.steps = stepsCollected;

            // Stale-answer guard: a response equal to the snapshot taken
            // BEFORE we sent the new prompt is, by definition, the previous
            // turn's answer (Perplexity has not yet overwritten the DOM).
            // Required by every completion branch — without it the polling
            // loop can hand back the previous answer for the new question
            // when `extractAgentStatus` matches stale markers still in the
            // scroll buffer.
            const responseIsFresh =
              !!status.response && status.response !== oldResponseSnapshot;

            // COMPLETION CONDITIONS (return immediately when any are met):

            // 1. Explicit completion detected by status checker
            if (status.status === 'completed' && sawNewResponse && responseIsFresh) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }

            // 2. Response is stable (same content for 2+ polls) and no stop button
            if (status.isStable && sawNewResponse && responseIsFresh && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }

            // 3. Idle timeout - no activity for 6s but we have a substantial response
            const idleTime = Date.now() - lastActivityTime;
            if (idleTime > IDLE_TIMEOUT && sawNewResponse && responseIsFresh &&
                status.response.length > 100 && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }
          } catch (pollError) {
            consecutiveErrors++;

            // Try to recover by switching to Perplexity tab
            try {
              const recovered = await cometClient.ensureOnPerplexityTab();
              if (recovered) {
                consecutiveErrors = Math.max(0, consecutiveErrors - 1);
                continue;
              }
            } catch {
              // Continue to fallback
            }

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              // Too many errors, try harder to recover
              try {
                await cometClient.ensureConnection();
                await cometClient.ensureOnPerplexityTab();
                consecutiveErrors = 0;
              } catch {
                // If still failing, exit loop and return partial result
                break;
              }
            }
            // Continue polling despite temporary errors
            continue;
          }
        }

        // Max timeout reached - return whatever we have.
        // Same stale-answer guard: only return text that actually changed
        // since we sent the prompt. If everything is stale we fall through
        // to the "in progress" branch below, which tells the caller to
        // keep polling rather than handing back the previous answer.
        const finalStatus = await cometAI.getAgentStatus();
        if (finalStatus.response && finalStatus.response.length > 50 &&
            finalStatus.response !== oldResponseSnapshot) {
          completeTask(finalStatus.response);
          return { content: [{ type: "text", text: finalStatus.response }] };
        }

        // No response - return progress info (task still active)
        let inProgressMsg = `Task may still be in progress (max timeout reached).\n`;
        inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
        if (finalStatus.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (stepsCollected.length > 0) {
          inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        // Keep task active since it may still be running
        sessionState.steps = stepsCollected;
        return { content: [{ type: "text", text: inProgressMsg }] };
      }

      case "comet_poll": {
        // Check if there's an active task session
        if (!sessionState.isActive && !sessionState.currentTaskId) {
          return { content: [{ type: "text", text: "Status: IDLE\nNo active task. Use comet_ask to start a new task." }] };
        }

        // Check for stale session (no activity for 5+ minutes)
        if (isSessionStale() && !sessionState.isActive) {
          return { content: [{ type: "text", text: "Status: IDLE\nPrevious task session expired. Use comet_ask to start a new task." }] };
        }

        // If task was already completed, return the cached response
        if (!sessionState.isActive && sessionState.lastResponse) {
          const timeSinceComplete = sessionState.lastResponseTime
            ? Math.round((Date.now() - sessionState.lastResponseTime) / 1000)
            : 0;
          return { content: [{ type: "text", text: `Status: COMPLETED (${timeSinceComplete}s ago)\n\n${sessionState.lastResponse}` }] };
        }

        // Active task - get fresh status from Perplexity
        await cometClient.ensureOnPerplexityTab();
        const status = await cometAI.getAgentStatus();

        // If completed, update session state and return response
        if (status.status === 'completed' && status.response) {
          completeTask(status.response);
          return { content: [{ type: "text", text: status.response }] };
        }

        // Still working - return progress info
        let output = `Status: ${status.status.toUpperCase()}\n`;
        if (sessionState.currentTaskId) {
          output += `Task: ${sessionState.currentTaskId}\n`;
        }

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        // Combine session steps with current status steps
        const allSteps = [...new Set([...sessionState.steps, ...status.steps])];
        if (allSteps.length > 0) {
          output += `\nSteps:\n${allSteps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working' || sessionState.isActive) {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometAI.stopAgent();
        if (stopped) {
          sessionState.isActive = false;
        }
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_tabs": {
        const action = (args?.action as string) || 'list';
        const domain = args?.domain as string | undefined;
        const tabId = args?.tabId as string | undefined;

        switch (action) {
          case 'list': {
            const summary = await cometClient.getTabSummary();
            return { content: [{ type: "text", text: summary }] };
          }

          case 'switch': {
            if (tabId) {
              try {
                validateTabId(tabId);
              } catch (e: any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
              }
              await cometClient.connect(tabId);
              return { content: [{ type: "text", text: `Switched to tab: ${tabId}` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab) {
                await cometClient.connect(tab.id);
                return { content: [{ type: "text", text: `Switched to ${tab.domain} (${tab.url})` }] };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to switch" }], isError: true };
          }

          case 'close': {
            // Safety check: don't close if it would leave no browsing tabs
            const allTabs = await cometClient.getTabContexts();

            // allTabs now only contains external tabs (Perplexity is filtered as internal)
            if (allTabs.length <= 1) {
              return { content: [{ type: "text", text: "Cannot close - this is the only browsing tab. Comet needs at least one external tab open." }], isError: true };
            }

            if (tabId) {
              try {
                validateTabId(tabId);
              } catch (e: any) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
              }
              const success = await cometClient.closeTab(tabId);
              return { content: [{ type: "text", text: success ? `Closed tab: ${tabId}` : `Failed to close tab` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab && tab.purpose !== 'main') {
                const success = await cometClient.closeTab(tab.id);
                return { content: [{ type: "text", text: success ? `Closed ${tab.domain}` : `Failed to close tab` }] };
              }
              if (tab?.purpose === 'main') {
                return { content: [{ type: "text", text: "Cannot close main Perplexity tab" }], isError: true };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to close" }], isError: true };
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}. Use: list, switch, close` }], isError: true };
        }
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await cometClient.evaluate(`
          (() => {
            // Strategy 1: Direct button (wide screen)
            const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
            if (btn) {
              btn.click();
              return { success: true, method: 'button' };
            }

            // Strategy 2: Dropdown menu (narrow screen)
            // Find and click the dropdown trigger (button with current mode text)
            const allButtons = document.querySelectorAll('button');
            for (const b of allButtons) {
              const text = b.innerText.toLowerCase();
              if ((text.includes('search') || text.includes('research') ||
                   text.includes('labs') || text.includes('learn')) &&
                  b.querySelector('svg')) {
                b.click();
                return { success: true, method: 'dropdown-open', needsSelect: true };
              }
            }

            return { success: false, error: "Mode selector not found" };
          })()
        `);

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown to open, then select the mode
          await new Promise(resolve => setTimeout(resolve, 300));
          // `mode` was validated against modeMap above, but encode anyway to
          // guarantee any future caller cannot inject JS via this template.
          const safeMode = JSON.stringify(mode);
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for dropdown menu items
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes(${safeMode})) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: "Mode option not found in dropdown" };
            })()
          `);
          const selectRes = selectResult.result.value as { success: boolean; error?: string };
          if (selectRes.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
      }

      case "comet_upload": {
        const filePath = args?.filePath as string;
        const selector = args?.selector as string | undefined;
        const checkOnly = args?.checkOnly as boolean | undefined;

        if (!filePath) {
          return { content: [{ type: "text", text: "Error: filePath is required" }], isError: true };
        }

        // Validate path: enforce COMET_UPLOAD_ROOT allowlist if set, else
        // block well-known secret locations. Resolves symlinks. Throws
        // user-facing message on rejection.
        let resolvedPath: string;
        try {
          resolvedPath = validateUploadPath(filePath);
        } catch (e: any) {
          return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }

        // If checkOnly, just report what file inputs exist
        if (checkOnly) {
          const inputInfo = await cometClient.hasFileInput();
          if (inputInfo.found) {
            let msg = `Found ${inputInfo.count} file input(s) on the page:\n`;
            msg += inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
            msg += `\n\nUse comet_upload with filePath to upload to one of these inputs.`;
            return { content: [{ type: "text", text: msg }] };
          } else {
            return { content: [{ type: "text", text: "No file input elements found on the current page. Navigate to a page with a file upload form first." }] };
          }
        }

        // Perform the upload with the canonical resolved path.
        const result = await cometClient.uploadFile(resolvedPath, selector);

        if (result.success) {
          return { content: [{ type: "text", text: result.message }] };
        } else {
          // If no input found, provide helpful info
          if (!result.inputFound) {
            const inputInfo = await cometClient.hasFileInput();
            let msg = result.message;
            if (inputInfo.found) {
              msg += `\n\nAvailable file inputs:\n${inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
              msg += `\n\nTry specifying a selector parameter.`;
            }
            return { content: [{ type: "text", text: msg }], isError: true };
          }
          return { content: [{ type: "text", text: result.message }], isError: true };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);

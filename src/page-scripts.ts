// Page-side scripts that run inside the Perplexity tab via CDP `evaluate`.
//
// Each function uses only browser globals (document, etc.) — never Node
// imports — so the same function body can run in two contexts:
//
//   - production: `cometClient.evaluate(\`(${fn.toString()})()\`)` ships the
//     function body into the page and returns its result through CDP
//   - tests: imported and called natively in vitest's jsdom env
//
// One source of truth, type-checked by TypeScript, exercised by unit tests.
// Do not add closure references or imports beyond DOM APIs — the
// stringified form would break.

export interface ProseState {
  count: number;
  lastText: string;
}

export function readProseState(): ProseState {
  const proseEls = document.querySelectorAll('[class*="prose"]');
  const lastProse = proseEls[proseEls.length - 1] as HTMLElement | undefined;
  return {
    count: proseEls.length,
    lastText: lastProse ? lastProse.innerText.substring(0, 100) : "",
  };
}

export interface AgentStatusResult {
  status: "idle" | "working" | "completed";
  steps: string[];
  currentStep: string;
  response: string;
  hasStopButton: boolean;
}

export function extractAgentStatus(): AgentStatusResult {
  const body = document.body.innerText;

  // Check for active stop button (more comprehensive check)
  let hasActiveStopButton = false;
  for (const btn of document.querySelectorAll("button")) {
    const rect = btn.querySelector("rect");
    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
    const btnText = btn.innerText.toLowerCase();

    // Stop button indicators: square icon (rect), "stop" label, or specific SVG patterns
    const isStopButton =
      rect ||
      ariaLabel.includes("stop") ||
      ariaLabel.includes("cancel") ||
      btnText === "stop";

    if (isStopButton && (btn as HTMLButtonElement).offsetParent !== null && !(btn as HTMLButtonElement).disabled) {
      hasActiveStopButton = true;
      break;
    }
  }

  // More comprehensive loading detection
  const hasLoadingSpinner =
    document.querySelector(
      '[class*="animate-spin"], [class*="animate-pulse"], [class*="loading"], [class*="thinking"]'
    ) !== null;

  // Check for "Thinking" indicator specifically
  const hasThinkingIndicator = body.includes("Thinking") && !body.includes("Thinking about");

  const hasStepsCompleted = /\d+ steps? completed/i.test(body);
  const hasFinishedMarker = body.includes("Finished") && !hasActiveStopButton;
  const hasReviewedSources = /Reviewed \d+ sources?/i.test(body);
  const hasSourcesIndicator = /\d+\s*sources?/i.test(body); // "10 sources" etc
  const hasAskFollowUp = body.includes("Ask a follow-up") || body.includes("Ask follow-up");

  // Check for prose content (actual response) - lowered threshold for short answers
  const proseEls = [...document.querySelectorAll('[class*="prose"]')] as HTMLElement[];
  const hasProseContent = proseEls.some((el) => {
    const text = el.innerText.trim();
    // Must have some content, not just UI text (lowered from 50 to 15 for short answers)
    return text.length > 15 && !text.startsWith("Library") && !text.startsWith("Discover");
  });

  const workingPatterns = [
    "Working", "Searching", "Reviewing sources", "Preparing to assist",
    "Clicking", "Typing:", "Navigating to", "Reading", "Analyzing",
    "Browsing", "Looking at", "Checking", "Opening", "Scrolling",
    "Waiting", "Processing",
  ];
  const hasWorkingText = workingPatterns.some((p) => body.includes(p));

  // Determine status with improved logic
  let status: "idle" | "working" | "completed" = "idle";

  // FIRST: Check if actively working (stop button is the strongest indicator)
  if (hasActiveStopButton) {
    status = "working";
  } else if (hasLoadingSpinner || hasThinkingIndicator) {
    status = "working";
  }
  // SECOND: Check completion indicators BEFORE working text
  // (because completed pages still show historical step text)
  else if (hasStepsCompleted || hasFinishedMarker) {
    status = "completed";
  } else if (hasAskFollowUp && hasProseContent) {
    status = "completed";
  } else if (hasSourcesIndicator && hasProseContent && !hasActiveStopButton) {
    status = "completed";
  } else if (hasReviewedSources && !hasActiveStopButton) {
    status = "completed";
  }
  // THIRD: Fall back to working text patterns (only if no completion signals)
  else if (hasWorkingText) {
    status = "working";
  }

  // Extract steps
  const steps: string[] = [];
  const stepPatterns = [
    /Preparing to assist[^\n]*/g, /Clicking[^\n]*/g, /Typing:[^\n]*/g,
    /Navigating[^\n]*/g, /Reading[^\n]*/g, /Searching[^\n]*/g, /Found[^\n]*/g,
  ];
  for (const pattern of stepPatterns) {
    const matches = body.match(pattern);
    if (matches) steps.push(...matches.map((s) => s.trim().substring(0, 100)));
  }

  // Extract response - get the FULL FINAL response after agent completes
  let response = "";
  if (status === "completed") {
    const mainContent = (document.querySelector("main") || document.body) as HTMLElement;
    const bodyText = mainContent.innerText;

    // Strategy 1: Find content after "X steps completed" marker (agent's final response)
    const stepsMatch = bodyText.match(/(\d+)\s*steps?\s*completed/i);
    if (stepsMatch) {
      const markerIndex = bodyText.indexOf(stepsMatch[0]);
      if (markerIndex !== -1) {
        // Get everything after the marker
        let afterMarker = bodyText.substring(markerIndex + stepsMatch[0].length).trim();

        // Remove the ">" or arrow that often follows
        afterMarker = afterMarker.replace(/^[>›→\s]+/, "").trim();

        // Find where the response ends (before input area or UI elements)
        const endMarkers = ["Ask anything", "Ask a follow-up", "Add details", "Type a message"];
        let endIndex = afterMarker.length;
        for (const marker of endMarkers) {
          const idx = afterMarker.indexOf(marker);
          if (idx !== -1 && idx < endIndex) {
            endIndex = idx;
          }
        }

        response = afterMarker.substring(0, endIndex).trim();
      }
    }

    // Strategy 2: If no steps marker, look for content after source citations
    if (!response || response.length < 50) {
      const sourcesMatch = bodyText.match(/Reviewed\s+\d+\s+sources?/i);
      if (sourcesMatch) {
        const markerIndex = bodyText.indexOf(sourcesMatch[0]);
        if (markerIndex !== -1) {
          let afterMarker = bodyText.substring(markerIndex + sourcesMatch[0].length).trim();
          const endMarkers = ["Ask anything", "Ask a follow-up", "Add details"];
          let endIndex = afterMarker.length;
          for (const marker of endMarkers) {
            const idx = afterMarker.indexOf(marker);
            if (idx !== -1 && idx < endIndex) endIndex = idx;
          }
          response = afterMarker.substring(0, endIndex).trim();
        }
      }
    }

    // Strategy 3: Fallback - get all prose content combined
    if (!response || response.length < 50) {
      const allProseEls = [...mainContent.querySelectorAll('[class*="prose"]')] as HTMLElement[];
      const validTexts = allProseEls
        .filter((el) => {
          if (el.closest("nav, aside, header, footer, form, [contenteditable]")) return false;
          const text = el.innerText.trim();
          const isUIText = ["Library", "Discover", "Spaces", "Finance", "Account",
                            "Upgrade", "Home", "Search"].some((ui) => text.startsWith(ui));
          return !isUIText && text.length > 30;
        })
        .map((el) => el.innerText.trim());

      // Combine all valid prose texts, taking the last/most recent ones
      if (validTexts.length > 0) {
        // Take last 3 prose blocks max (most recent response)
        response = validTexts.slice(-3).join("\n\n");
      }
    }

    // Clean up response - preserve formatting but remove UI artifacts
    if (response) {
      response = response
        .replace(/View All/gi, "")
        .replace(/Show more/gi, "")
        .replace(/Ask a follow-up/gi, "")
        .replace(/Ask anything\.*/gi, "")
        .replace(/Add details to this task\.*/gi, "")
        .replace(/\d+\s*sources?\s*$/gi, "")
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, "") // Remove most emojis from UI
        .replace(/^[>›→\s]+/gm, "") // Remove leading arrows
        .replace(/\n{3,}/g, "\n\n") // Collapse multiple newlines
        .trim();
    }
  }

  return {
    status,
    steps: [...new Set(steps)].slice(-5),
    currentStep: steps.length > 0 ? steps[steps.length - 1] : "",
    response: response.substring(0, 8000),
    hasStopButton: hasActiveStopButton,
  };
}

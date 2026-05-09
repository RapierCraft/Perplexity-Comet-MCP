// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    // Use execCommand for contenteditable elements (works with React/Vue)
    const result = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          return { success: true };
        }
        // Fallback for textarea
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = ${JSON.stringify(prompt)};
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true };
        }
        return { success: false };
      })()
    `);

    const typed = (result.result.value as { success: boolean })?.success;
    if (!typed) {
      throw new Error("Failed to type into input element");
    }

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify text was typed before attempting submit
    const hasContent = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length > 0) return true;
        const textarea = document.querySelector('textarea');
        if (textarea && textarea.value.trim().length > 0) return true;
        return false;
      })()
    `);

    if (!hasContent.result.value) {
      throw new Error("Prompt text not found in input - typing may have failed");
    }

    // Strategy 1: Simulate Enter key via DOM events (most reliable for contenteditable)
    const enterResult = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (!el) return { success: false, reason: 'no input element' };

        el.focus();

        // Create and dispatch Enter key events
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });

        el.dispatchEvent(enterEvent);

        // Also dispatch keyup
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        el.dispatchEvent(keyupEvent);

        return { success: true };
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 800));

    // Check if submission worked
    const submitted = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        // If input is empty or nearly empty, submission worked
        if (el && el.innerText.trim().length < 5) return true;
        // Check for loading indicators
        const hasLoading = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click the submit button directly
    const clickResult = await cometClient.evaluate(`
      (() => {
        // Try specific submit button selectors first
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          'form button[type="button"]:last-of-type',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { success: true, method: 'selector', selector: sel };
          }
        }

        // Find the submit button by position (usually rightmost button near input)
        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          // Search up the DOM tree
          for (let i = 0; i < 5 && parent; i++) {
            const btns = parent.querySelectorAll('button');
            for (const btn of btns) {
              if (btn.disabled || btn.offsetParent === null) continue;

              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              // Skip mode/attach/voice/menu buttons
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('voice') ||
                  ariaLabel.includes('menu') || ariaLabel.includes('more')) {
                continue;
              }

              // Button should be visible and to the right of input
              if (btnRect.width > 0 && btnRect.height > 0) {
                candidates.push({ btn, x: btnRect.right, y: btnRect.top });
              }
            }
            parent = parent.parentElement;
          }

          // Click the rightmost button (usually submit)
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.x - a.x);
            candidates[0].btn.click();
            return { success: true, method: 'position' };
          }
        }

        return { success: false, reason: 'no button found' };
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Final verification and last resort
    const finalCheck = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);

    if (!finalCheck.result.value) {
      // Last resort: try form submit
      await cometClient.evaluate(`
        (() => {
          const form = document.querySelector('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        })()
      `);
    }
  }

  // Track response stability for completion detection
  private lastResponseText: string = '';
  private stableResponseCount: number = 0;
  private readonly STABILITY_THRESHOLD: number = 2; // Response must be same for 2 checks

  /**
   * Check if response has stabilized (same content for multiple polls)
   */
  isResponseStable(currentResponse: string): boolean {
    if (currentResponse && currentResponse.length > 50) {
      if (currentResponse === this.lastResponseText) {
        this.stableResponseCount++;
      } else {
        this.stableResponseCount = 0;
        this.lastResponseText = currentResponse;
      }
      return this.stableResponseCount >= this.STABILITY_THRESHOLD;
    }
    return false;
  }

  /**
   * Reset stability tracking (call when starting new prompt)
   */
  resetStabilityTracking(): void {
    this.lastResponseText = '';
    this.stableResponseCount = 0;
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
    isStable: boolean;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // Check for active stop button (more comprehensive check)
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const rect = btn.querySelector('rect');
          const svg = btn.querySelector('svg');
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnText = btn.innerText.toLowerCase();

          // Stop button indicators: square icon (rect), "stop" label, or specific SVG patterns
          const isStopButton = rect ||
                              ariaLabel.includes('stop') ||
                              ariaLabel.includes('cancel') ||
                              btnText === 'stop';

          if (isStopButton && btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        // More comprehensive loading detection
        const hasLoadingSpinner = document.querySelector(
          '[class*="animate-spin"], [class*="animate-pulse"], [class*="loading"], [class*="thinking"]'
        ) !== null;

        // Check for "Thinking" indicator specifically
        const hasThinkingIndicator = body.includes('Thinking') && !body.includes('Thinking about');

        // Completion markers — multilingual.
        // Perplexity localizes its UI (ru, de, es, fr, etc). English-only patterns
        // miss completion on non-English accounts and force fallback to slow
        // response-stability polling (~90s). See PR notes for marker source.
        const hasStepsCompleted = /\\d+ steps? completed/i.test(body)
                               || /Выполнено\\s+\\d+\\s+шаг(?:а|ов)?/iu.test(body); // ru
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);
        const hasSourcesIndicator = /\\d+\\s*sources?/i.test(body)              // en
                                 || /\\d+\\s*источник(?:а|ов)?/iu.test(body);    // ru
        const hasAskFollowUp = body.includes('Ask a follow-up')
                            || body.includes('Ask follow-up')
                            || body.includes('Задайте уточняющий вопрос')         // ru: input placeholder
                            || body.includes('Последующие вопросы');              // ru: section heading

        // Check for prose content (actual response) - lowered threshold for short answers
        const proseEls = [...document.querySelectorAll('[class*="prose"]')];
        const hasProseContent = proseEls.some(el => {
          const text = el.innerText.trim();
          // Must have some content, not just UI text (lowered from 50 to 15 for short answers)
          return text.length > 15 && !text.startsWith('Library') && !text.startsWith('Discover');
        });

        // Check if input is focused (user might be typing, not agent working)
        const inputFocused = document.activeElement?.matches('[contenteditable], textarea, input');

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing',
          'Browsing', 'Looking at', 'Checking', 'Opening', 'Scrolling',
          'Waiting', 'Processing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Determine status with improved logic
        let status = 'idle';

        // FIRST: Check if actively working (stop button is the strongest indicator)
        if (hasActiveStopButton) {
          status = 'working';
        } else if (hasLoadingSpinner || hasThinkingIndicator) {
          status = 'working';
        }
        // SECOND: Check completion indicators BEFORE working text
        // (because completed pages still show historical step text)
        else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasAskFollowUp && hasProseContent) {
          status = 'completed';
        } else if (hasSourcesIndicator && hasProseContent && !hasActiveStopButton) {
          status = 'completed';
        } else if (hasReviewedSources && !hasActiveStopButton) {
          status = 'completed';
        }
        // THIRD: Fall back to working text patterns (only if no completion signals)
        else if (hasWorkingText) {
          status = 'working';
        }

        // Extract steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g, /Clicking[^\\n]*/g, /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g, /Reading[^\\n]*/g, /Searching[^\\n]*/g, /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        // Extract response - get the FULL FINAL response after agent completes
        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.body;
          const bodyText = mainContent.innerText;

          // Strategy 1: Find content after "X steps completed" marker (agent's final response)
          const stepsMatch = bodyText.match(/(\\d+)\\s*steps?\\s*completed/i);
          if (stepsMatch) {
            const markerIndex = bodyText.indexOf(stepsMatch[0]);
            if (markerIndex !== -1) {
              // Get everything after the marker
              let afterMarker = bodyText.substring(markerIndex + stepsMatch[0].length).trim();

              // Remove the ">" or arrow that often follows
              afterMarker = afterMarker.replace(/^[>›→\\s]+/, '').trim();

              // Find where the response ends (before input area or UI elements)
              const endMarkers = [
                'Ask anything', 'Ask a follow-up', 'Add details', 'Type a message',
                'Задайте уточняющий вопрос', 'Последующие вопросы' // ru
              ];
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
            const sourcesMatch = bodyText.match(/Reviewed\\s+\\d+\\s+sources?/i);
            if (sourcesMatch) {
              const markerIndex = bodyText.indexOf(sourcesMatch[0]);
              if (markerIndex !== -1) {
                let afterMarker = bodyText.substring(markerIndex + sourcesMatch[0].length).trim();
                const endMarkers = [
                  'Ask anything', 'Ask a follow-up', 'Add details',
                  'Задайте уточняющий вопрос', 'Последующие вопросы' // ru
                ];
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
            const allProseEls = [...mainContent.querySelectorAll('[class*="prose"]')];
            const validTexts = allProseEls
              .filter(el => {
                if (el.closest('nav, aside, header, footer, form, [contenteditable]')) return false;
                const text = el.innerText.trim();
                const isUIText = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                                  'Upgrade', 'Home', 'Search'].some(ui => text.startsWith(ui));
                return !isUIText && text.length > 30;
              })
              .map(el => el.innerText.trim());

            // Combine all valid prose texts, taking the last/most recent ones
            if (validTexts.length > 0) {
              // Take last 3 prose blocks max (most recent response)
              response = validTexts.slice(-3).join('\\n\\n');
            }
          }

          // Clean up response - preserve formatting but remove UI artifacts
          if (response) {
            response = response
              .replace(/View All/gi, '')
              .replace(/Show more/gi, '')
              .replace(/Ask a follow-up/gi, '')
              .replace(/Ask anything\\.*/gi, '')
              .replace(/Add details to this task\\.*/gi, '')
              .replace(/Задайте уточняющий вопрос/giu, '')        // ru
              .replace(/Последующие вопросы/giu, '')              // ru
              .replace(/\\d+\\s*sources?\\s*$/gi, '')
              .replace(/\\d+\\s*источник(?:а|ов)?\\s*$/giu, '')   // ru
              .replace(/[\\u{1F300}-\\u{1F9FF}]/gu, '') // Remove most emojis from UI
              .replace(/^[>›→\\s]+/gm, '') // Remove leading arrows
              .replace(/\\n{3,}/g, '\\n\\n') // Collapse multiple newlines
              .trim();
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 8000),
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    const statusResult = result.result.value as {
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
    };

    // Check response stability
    const isStable = this.isResponseStable(statusResult.response);

    // If response is stable and has content, override status to completed
    if (isStable && statusResult.response.length > 50 && !statusResult.hasStopButton) {
      statusResult.status = 'completed';
    }

    return {
      ...statusResult,
      agentBrowsingUrl,
      isStable,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }
}

export const cometAI = new CometAI();

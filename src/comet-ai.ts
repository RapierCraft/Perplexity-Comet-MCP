// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";
import { extractAgentStatus, type AgentStatusResult } from "./page-scripts.js";

/**
 * Minimal CDP-client surface used by `CometAI.getAgentStatus`. Letting
 * callers inject a stand-in (in unit tests) avoids spinning up real
 * CDP infrastructure to exercise the status-extraction logic. Methods
 * outside this set continue to use the module-level `cometClient`.
 */
export type CometAIClient = Pick<typeof cometClient, "safeEvaluate" | "listTabsCategorized">;

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  private readonly client: CometAIClient;

  constructor(client: CometAIClient = cometClient) {
    this.client = client;
  }

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
      const tabs = await this.client.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await this.client.safeEvaluate(`(${extractAgentStatus.toString()})()`);

    const statusResult = result.result.value as AgentStatusResult;

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

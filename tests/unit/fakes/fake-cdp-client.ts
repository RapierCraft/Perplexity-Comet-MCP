// Minimal fake of the CDP-client surface that `CometAI.getAgentStatus` uses.
// Implements just `safeEvaluate` and `listTabsCategorized` — enough to
// satisfy the `CometAIClient` type — and records every call so tests can
// assert on the JS payload sent to `evaluate`.

import type { CometAIClient } from "../../../src/comet-ai.js";
import type { CDPTarget, EvaluateResult } from "../../../src/types.js";

interface CategorizedTabs {
  main: CDPTarget | null;
  sidecar: CDPTarget | null;
  agentBrowsing: CDPTarget | null;
  overlay: CDPTarget | null;
  others: CDPTarget[];
}

const EMPTY_TABS: CategorizedTabs = {
  main: null,
  sidecar: null,
  agentBrowsing: null,
  overlay: null,
  others: [],
};

export class FakeCdpClient implements CometAIClient {
  /** Records every JS expression passed to `safeEvaluate`. */
  public readonly evaluateCalls: string[] = [];

  /** Programmable response for the next (and subsequent) safeEvaluate calls. */
  private nextEvaluateResult: EvaluateResult = {
    result: { type: "object", value: undefined },
  };

  /** Programmable response for listTabsCategorized. */
  private nextTabsResult: CategorizedTabs = EMPTY_TABS;

  setEvaluateResult(value: unknown): void {
    this.nextEvaluateResult = {
      result: { type: typeof value === "object" ? "object" : "string", value },
    };
  }

  setTabsResult(tabs: Partial<CategorizedTabs>): void {
    this.nextTabsResult = { ...EMPTY_TABS, ...tabs };
  }

  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    this.evaluateCalls.push(expression);
    return this.nextEvaluateResult;
  }

  async listTabsCategorized(): Promise<CategorizedTabs> {
    return this.nextTabsResult;
  }
}

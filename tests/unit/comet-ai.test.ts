import { describe, it, expect } from "vitest";
import { CometAI } from "../../src/comet-ai.js";
import { FakeCdpClient } from "./fakes/fake-cdp-client.js";

// `isResponseStable` only tracks responses longer than 50 characters
// (short responses never stabilize). Use long strings in assertions.
const ANSWER_A = "A".repeat(60);
const ANSWER_B = "B".repeat(60);

describe("CometAI.isResponseStable", () => {
  it("returns false on the first observation of any response", () => {
    const ai = new CometAI(new FakeCdpClient());
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
  });

  it("returns true on the third identical observation (threshold = 2)", () => {
    const ai = new CometAI(new FakeCdpClient());
    // Call 1: records the text, counter stays 0
    // Call 2: same text, counter increments to 1 → still below threshold
    // Call 3: same text, counter increments to 2 → meets threshold
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true);
  });

  it("resets the stable counter when the response text changes", () => {
    const ai = new CometAI(new FakeCdpClient());
    ai.isResponseStable(ANSWER_A);
    ai.isResponseStable(ANSWER_A);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true); // stable

    // Different text resets the counter
    expect(ai.isResponseStable(ANSWER_B)).toBe(false);
    expect(ai.isResponseStable(ANSWER_B)).toBe(false);
    expect(ai.isResponseStable(ANSWER_B)).toBe(true); // stable again
  });

  it("returns false for short responses (length <= 50) regardless of repetition", () => {
    const ai = new CometAI(new FakeCdpClient());
    expect(ai.isResponseStable("short")).toBe(false);
    expect(ai.isResponseStable("short")).toBe(false);
    expect(ai.isResponseStable("short")).toBe(false);
  });

  it("returns false for empty responses regardless of repetition", () => {
    const ai = new CometAI(new FakeCdpClient());
    expect(ai.isResponseStable("")).toBe(false);
    expect(ai.isResponseStable("")).toBe(false);
    expect(ai.isResponseStable("")).toBe(false);
  });
});

describe("CometAI.resetStabilityTracking", () => {
  it("zeros the stable counter after a stable response", () => {
    const ai = new CometAI(new FakeCdpClient());
    ai.isResponseStable(ANSWER_A);
    ai.isResponseStable(ANSWER_A);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true);

    ai.resetStabilityTracking();

    // After reset, the same response needs the full sequence again
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true);
  });
});

describe("CometAI.getAgentStatus", () => {
  it("returns the parsed shape from a canned safeEvaluate result", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "completed",
      steps: ["Searching for X", "Reading results"],
      currentStep: "Reading results",
      response: "the agent's final answer",
      hasStopButton: false,
    });

    const ai = new CometAI(fake);
    const status = await ai.getAgentStatus();

    expect(status.status).toBe("completed");
    expect(status.steps).toEqual(["Searching for X", "Reading results"]);
    expect(status.currentStep).toBe("Reading results");
    expect(status.response).toBe("the agent's final answer");
    expect(status.hasStopButton).toBe(false);
    expect(status.agentBrowsingUrl).toBe("");
    expect(typeof status.isStable).toBe("boolean");
  });

  it("includes the agent-browsing URL when listTabsCategorized returns one", async () => {
    const fake = new FakeCdpClient();
    fake.setTabsResult({
      agentBrowsing: {
        id: "tab-1",
        type: "page",
        title: "Whole Foods",
        url: "https://amazon.com/alm/storefront",
      },
    });
    fake.setEvaluateResult({
      status: "working",
      steps: [],
      currentStep: "",
      response: "",
      hasStopButton: true,
    });

    const ai = new CometAI(fake);
    const status = await ai.getAgentStatus();

    expect(status.agentBrowsingUrl).toBe("https://amazon.com/alm/storefront");
    expect(status.status).toBe("working");
    expect(status.hasStopButton).toBe(true);
  });

  it("ships a stringified IIFE of extractAgentStatus to safeEvaluate", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "idle",
      steps: [],
      currentStep: "",
      response: "",
      hasStopButton: false,
    });

    const ai = new CometAI(fake);
    await ai.getAgentStatus();

    expect(fake.evaluateCalls.length).toBe(1);
    const js = fake.evaluateCalls[0];
    expect(js).toContain("function extractAgentStatus");
    // Wrapped as an immediately-invoked function expression
    expect(js.endsWith(")()")).toBe(true);
  });
});

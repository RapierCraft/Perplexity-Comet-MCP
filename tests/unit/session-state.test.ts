import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  sessionState,
  startNewTask,
  completeTask,
  isSessionStale,
  generateTaskId,
} from "../../src/session-state.js";

function resetSessionState(): void {
  sessionState.currentTaskId = null;
  sessionState.taskStartTime = null;
  sessionState.lastPrompt = null;
  sessionState.lastResponse = null;
  sessionState.lastResponseTime = null;
  sessionState.steps = [];
  sessionState.isActive = false;
}

beforeEach(() => {
  resetSessionState();
});

describe("generateTaskId", () => {
  it("returns a string in the form task_<unix-ms>_<uuid v4>", () => {
    const id = generateTaskId();
    expect(id).toMatch(/^task_\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns unique ids across rapid successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(100);
  });
});

describe("startNewTask", () => {
  it("populates session state for a fresh task", () => {
    const before = Date.now();
    const taskId = startNewTask("hello");
    const after = Date.now();

    expect(sessionState.currentTaskId).toBe(taskId);
    expect(sessionState.lastPrompt).toBe("hello");
    expect(sessionState.isActive).toBe(true);
    expect(sessionState.steps).toEqual([]);
    expect(sessionState.taskStartTime).toBeGreaterThanOrEqual(before);
    expect(sessionState.taskStartTime).toBeLessThanOrEqual(after);
  });

  it("clears prior lastResponse / lastResponseTime / steps from a previous task", () => {
    sessionState.lastResponse = "previous answer";
    sessionState.lastResponseTime = 12345;
    sessionState.steps = ["old step 1", "old step 2"];

    startNewTask("a fresh prompt");

    expect(sessionState.lastResponse).toBeNull();
    expect(sessionState.lastResponseTime).toBeNull();
    expect(sessionState.steps).toEqual([]);
  });

  it("returns a task id that matches the format from generateTaskId", () => {
    const taskId = startNewTask("any");
    expect(taskId).toMatch(/^task_\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("completeTask", () => {
  it("writes lastResponse, stamps lastResponseTime, sets isActive=false", () => {
    startNewTask("a prompt");
    expect(sessionState.isActive).toBe(true);

    const before = Date.now();
    completeTask("the answer");
    const after = Date.now();

    expect(sessionState.lastResponse).toBe("the answer");
    expect(sessionState.isActive).toBe(false);
    expect(sessionState.lastResponseTime).toBeGreaterThanOrEqual(before);
    expect(sessionState.lastResponseTime).toBeLessThanOrEqual(after);
  });
});

describe("isSessionStale", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when taskStartTime is null", () => {
    sessionState.taskStartTime = null;
    expect(isSessionStale()).toBe(true);
  });

  it("returns false at 4:59 after task start", () => {
    startNewTask("a prompt");
    vi.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000);
    expect(isSessionStale()).toBe(false);
  });

  it("returns true at 5:01 after task start", () => {
    startNewTask("a prompt");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(isSessionStale()).toBe(true);
  });
});

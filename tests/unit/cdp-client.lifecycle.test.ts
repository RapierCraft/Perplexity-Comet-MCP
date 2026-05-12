import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FrameLifecycleMap,
  waitForLifecycle,
} from "../../src/cdp-client.js";
import { FakeLifecyclePage } from "./fakes/fake-lifecycle-page.js";

function makeMap(): FrameLifecycleMap {
  return new Map();
}

function seedFrame(
  map: FrameLifecycleMap,
  frameId: string,
  loaderId: string,
  events: string[],
): void {
  map.set(frameId, { loaderId, events: new Set(events) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForLifecycle — cache-hit path", () => {
  it("resolves true when the event is already in the cache", async () => {
    const page = new FakeLifecyclePage();
    const map = makeMap();
    seedFrame(map, "frame-1", "loader-A", ["firstContentfulPaint"]);

    await expect(
      waitForLifecycle(page, map, "firstContentfulPaint", 2000),
    ).resolves.toBe(true);
  });

  it("unsubscribes its listener even when the cache hit fires synchronously", async () => {
    // Defensive ordering: the listener is registered before the cache scan,
    // so a cache hit still has to release it. This guards finding #1 (no
    // leaked listeners across calls).
    const page = new FakeLifecyclePage();
    const map = makeMap();
    seedFrame(map, "frame-1", "loader-A", ["firstContentfulPaint"]);

    await waitForLifecycle(page, map, "firstContentfulPaint", 2000);

    expect(page.registrations).toBe(1);
    expect(page.unsubscribes).toBe(1);
    expect(page.liveHandlerCount()).toBe(0);
  });

  it("ignores cache entries for unrelated events and falls through to the listener path", async () => {
    vi.useFakeTimers();
    const page = new FakeLifecyclePage();
    const map = makeMap();
    seedFrame(map, "frame-1", "loader-A", ["load", "domContentLoaded"]);

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    expect(page.liveHandlerCount()).toBe(1);

    vi.advanceTimersByTime(2000);
    await expect(pending).resolves.toBe(false);
  });
});

describe("waitForLifecycle — listener path", () => {
  it("resolves true when the event arrives after registration", async () => {
    const page = new FakeLifecyclePage();
    const map = makeMap();

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    page.emit("firstContentfulPaint");

    await expect(pending).resolves.toBe(true);
  });

  it("unsubscribes after firing", async () => {
    const page = new FakeLifecyclePage();
    const map = makeMap();

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    page.emit("firstContentfulPaint");
    await pending;

    expect(page.unsubscribes).toBe(1);
    expect(page.liveHandlerCount()).toBe(0);
  });

  it("ignores unrelated events", async () => {
    vi.useFakeTimers();
    const page = new FakeLifecyclePage();
    const map = makeMap();

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    page.emit("load");
    page.emit("domContentLoaded");
    page.emit("networkAlmostIdle");
    vi.advanceTimersByTime(2000);

    await expect(pending).resolves.toBe(false);
  });

  it("registers the listener before the cache scan (defensive ordering)", () => {
    // Single-threaded JS makes this safe today even without the ordering;
    // the test pins the behavior so a future refactor can't silently
    // reintroduce a microtask-window race.
    const page = new FakeLifecyclePage();
    const map = makeMap();

    // The cache is empty — if the scan ran before registration, the
    // listener would never be registered before the function returned
    // its pending Promise. Asserting that the handler is live immediately
    // after the call confirms the order.
    waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    expect(page.liveHandlerCount()).toBe(1);
  });
});

describe("waitForLifecycle — timeout path", () => {
  it("resolves false when the timeout elapses with no event", async () => {
    vi.useFakeTimers();
    const page = new FakeLifecyclePage();
    const map = makeMap();

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    vi.advanceTimersByTime(2000);

    await expect(pending).resolves.toBe(false);
  });

  it("unsubscribes on timeout", async () => {
    vi.useFakeTimers();
    const page = new FakeLifecyclePage();
    const map = makeMap();

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    vi.advanceTimersByTime(2000);
    await pending;

    expect(page.unsubscribes).toBe(1);
    expect(page.liveHandlerCount()).toBe(0);
  });

  it("does not resolve before the timeout fires", async () => {
    vi.useFakeTimers();
    const page = new FakeLifecyclePage();
    const map = makeMap();

    const pending = waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    vi.advanceTimersByTime(1999);

    const settled = await Promise.race([
      pending.then((v) => ({ resolved: true, value: v })),
      Promise.resolve({ resolved: false as const }),
    ]);
    expect(settled).toEqual({ resolved: false });

    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toBe(false);
  });
});

describe("waitForLifecycle — error handling", () => {
  it("resolves false (best-effort) when page.lifecycleEvent throws", async () => {
    // Models the connect()-time guard: if CRI rejects the subscription
    // (older protocol versions, etc.), `waitForLifecycle` should degrade
    // to "feature not available" rather than throw.
    const page = new FakeLifecyclePage();
    page.setLifecycleEventToThrow();
    const map = makeMap();

    await expect(
      waitForLifecycle(page, map, "firstContentfulPaint", 2000),
    ).resolves.toBe(false);
  });

  it("does not register a timer when the listener registration throws", async () => {
    vi.useFakeTimers();
    const page = new FakeLifecyclePage();
    page.setLifecycleEventToThrow();
    const map = makeMap();

    await waitForLifecycle(page, map, "firstContentfulPaint", 2000);
    // If a timer leaked, advancing time after the Promise settled would
    // do nothing observable here, but the more important assertion is that
    // no handler was ever registered:
    expect(page.registrations).toBe(0);
    expect(page.liveHandlerCount()).toBe(0);
  });
});

describe("waitForLifecycle — scanning frameLifecycle", () => {
  it("finds an event registered under any frameId", async () => {
    const page = new FakeLifecyclePage();
    const map = makeMap();
    seedFrame(map, "frame-A", "loader-1", ["load"]);
    seedFrame(map, "frame-B", "loader-2", ["firstContentfulPaint"]);
    seedFrame(map, "frame-C", "loader-3", ["domContentLoaded"]);

    await expect(
      waitForLifecycle(page, map, "firstContentfulPaint", 2000),
    ).resolves.toBe(true);
  });
});

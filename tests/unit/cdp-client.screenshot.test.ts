import { describe, it, expect } from "vitest";
import { captureScreenshotWithFallback } from "../../src/cdp-client.js";
import { FakeScreenshotPage } from "./fakes/fake-screenshot-page.js";

const FALLBACK_CLIP = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  scale: 1,
};

// The predicate that triggers the fallback is `!width && !height` — both
// dimensions must be zero. Live CDP testing showed 0×0 is the only
// reproducible state that hangs Page.captureScreenshot: Chromium's
// Emulation.setDeviceMetricsOverride rejects single-zero dimensions, and
// the natural 0×0 case (visibilityState='hidden' with no layout computed)
// is all-or-nothing. PNG/JPEG headers also require both dimensions to be
// >= 1, so a zero-dim image isn't a valid output format. The 0×N and N×0
// boundary tests below therefore expect the wrapper to NOT apply the
// fallback (no synthetic 1280×800 masking the anomaly) and to surface
// the inevitable encoder failure via the empty-data guard.
describe("captureScreenshotWithFallback — non-degenerate viewport", () => {
  it("forwards format and supplies no clip when the cssLayoutViewport is non-zero", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({ cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } });

    await captureScreenshotWithFallback(page, "png");

    expect(page.captureScreenshotCalls).toHaveLength(1);
    expect(page.captureScreenshotCalls[0]).toEqual({ format: "png" });
  });

  it("falls back to layoutViewport when cssLayoutViewport is missing", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({ layoutViewport: { clientWidth: 800, clientHeight: 600 } });

    await captureScreenshotWithFallback(page, "png");

    expect(page.captureScreenshotCalls[0]).toEqual({ format: "png" });
  });

  it("passes through (no fallback) and fails loudly when only width is 0", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({ cssLayoutViewport: { clientWidth: 0, clientHeight: 800 } });
    // Model real-browser behavior: no encoder can produce output for a
    // zero-dim image, so the captureScreenshot call returns empty data.
    page.setScreenshotData(undefined);

    await expect(captureScreenshotWithFallback(page, "png")).rejects.toThrow(
      /empty data/i,
    );
    expect(page.captureScreenshotCalls[0]).toEqual({ format: "png" });
  });

  it("passes through (no fallback) and fails loudly when only height is 0", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({ cssLayoutViewport: { clientWidth: 1024, clientHeight: 0 } });
    page.setScreenshotData(undefined);

    await expect(captureScreenshotWithFallback(page, "png")).rejects.toThrow(
      /empty data/i,
    );
    expect(page.captureScreenshotCalls[0]).toEqual({ format: "png" });
  });

  it("forwards jpeg format unchanged", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({ cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 } });

    await captureScreenshotWithFallback(page, "jpeg");

    expect(page.captureScreenshotCalls[0]).toEqual({ format: "jpeg" });
  });

  it("calls bringToFront before capture (best-effort)", async () => {
    const page = new FakeScreenshotPage();
    await captureScreenshotWithFallback(page, "png");
    expect(page.bringToFrontCalls).toBe(1);
  });
});

describe("captureScreenshotWithFallback — degenerate viewport", () => {
  it("supplies the fallback clip + captureBeyondViewport when viewport is 0×0", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({ cssLayoutViewport: { clientWidth: 0, clientHeight: 0 } });

    await captureScreenshotWithFallback(page, "png");

    expect(page.captureScreenshotCalls[0]).toEqual({
      format: "png",
      captureBeyondViewport: true,
      clip: FALLBACK_CLIP,
    });
  });

  // Chrome-side rejection (ProtocolError) on getLayoutMetrics typically
  // means the method isn't supported on this target type. The wrapper
  // recovers because captureScreenshot may still succeed at the fallback
  // dimensions.
  it("supplies the fallback clip when getLayoutMetrics throws a ProtocolError", async () => {
    const page = new FakeScreenshotPage();
    page.setMetricsToThrowProtocolError();

    await captureScreenshotWithFallback(page, "png");

    expect(page.captureScreenshotCalls[0]).toEqual({
      format: "png",
      captureBeyondViewport: true,
      clip: FALLBACK_CLIP,
    });
  });

  // Transport-level or unexpected errors must NOT be masked with a
  // synthetic 1280x800 capture — propagate so the caller sees the real
  // failure (websocket dropped, target detached, etc.).
  it("propagates non-ProtocolError throws from getLayoutMetrics", async () => {
    const page = new FakeScreenshotPage();
    page.setMetricsToThrowGeneric();

    await expect(captureScreenshotWithFallback(page, "png")).rejects.toThrow(
      /websocket dropped/i,
    );
    expect(page.captureScreenshotCalls).toHaveLength(0);
  });

  it("supplies the fallback clip when both viewport fields are absent", async () => {
    const page = new FakeScreenshotPage();
    page.setMetrics({});

    await captureScreenshotWithFallback(page, "png");

    expect(page.captureScreenshotCalls[0]).toEqual({
      format: "png",
      captureBeyondViewport: true,
      clip: FALLBACK_CLIP,
    });
  });
});

describe("captureScreenshotWithFallback — error handling", () => {
  it("swallows bringToFront errors and continues to capture", async () => {
    const page = new FakeScreenshotPage();
    page.setBringToFrontToThrow();

    const result = await captureScreenshotWithFallback(page, "png");

    expect(page.captureScreenshotCalls).toHaveLength(1);
    expect(result.data).toBeTruthy();
  });

  it("throws a descriptive error when captureScreenshot returns empty data", async () => {
    const page = new FakeScreenshotPage();
    page.setScreenshotData(undefined);

    await expect(captureScreenshotWithFallback(page, "png")).rejects.toThrow(
      /empty data/i,
    );
  });
});

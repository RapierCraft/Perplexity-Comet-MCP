// Minimal fake of the CDP `Page` slice that `captureScreenshotWithFallback`
// uses. Implements just `bringToFront`, `getLayoutMetrics`, and
// `captureScreenshot` — enough to satisfy the `ScreenshotPageAPI` type — and
// records every call so tests can assert on the args.

import CDP from "chrome-remote-interface";
import type { ScreenshotPageAPI } from "../../../src/cdp-client.js";
import type { ScreenshotResult } from "../../../src/types.js";

// chrome-remote-interface@^0.34.0 exposes ProtocolError but @types doesn't
// declare it; mirror the cast pattern used in src/cdp-client.ts so tests can
// construct one for the discriminator check.
const ProtocolError = (CDP as unknown as {
  ProtocolError: new (
    request: { method: string },
    response: { code: number; message: string; data?: string },
  ) => Error;
}).ProtocolError;

type LayoutMetrics = Awaited<ReturnType<ScreenshotPageAPI["getLayoutMetrics"]>>;
type CaptureScreenshotArgs = Parameters<ScreenshotPageAPI["captureScreenshot"]>[0];

type ThrowMode = "none" | "protocol-error" | "generic";

export class FakeScreenshotPage implements ScreenshotPageAPI {
  public bringToFrontCalls = 0;
  public readonly captureScreenshotCalls: CaptureScreenshotArgs[] = [];

  private bringToFrontShouldThrow = false;
  private metricsResponse: LayoutMetrics = {
    cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 },
  };
  private metricsThrowMode: ThrowMode = "none";
  private screenshotData: string | undefined = "ZmFrZS1zY3JlZW5zaG90LWRhdGE="; // base64 "fake-screenshot-data"

  setMetrics(metrics: LayoutMetrics): void {
    this.metricsResponse = metrics;
    this.metricsThrowMode = "none";
  }

  /** Make `getLayoutMetrics` throw a `CDP.ProtocolError` — models Chrome
   * rejecting the method (e.g. unsupported on a non-page target). */
  setMetricsToThrowProtocolError(): void {
    this.metricsThrowMode = "protocol-error";
  }

  /** Make `getLayoutMetrics` throw a plain `Error` — models transport-level
   * or unexpected failures that should propagate, not trigger the fallback. */
  setMetricsToThrowGeneric(): void {
    this.metricsThrowMode = "generic";
  }

  setBringToFrontToThrow(): void {
    this.bringToFrontShouldThrow = true;
  }

  setScreenshotData(data: string | undefined): void {
    this.screenshotData = data;
  }

  async bringToFront(): Promise<void> {
    this.bringToFrontCalls++;
    if (this.bringToFrontShouldThrow) {
      throw new Error("bringToFront not supported on this target");
    }
  }

  async getLayoutMetrics(): Promise<LayoutMetrics> {
    if (this.metricsThrowMode === "protocol-error") {
      throw new ProtocolError(
        { method: "Page.getLayoutMetrics" },
        { code: -32601, message: "'Page.getLayoutMetrics' wasn't found" },
      );
    }
    if (this.metricsThrowMode === "generic") {
      throw new Error("websocket dropped");
    }
    return this.metricsResponse;
  }

  async captureScreenshot(opts: CaptureScreenshotArgs): Promise<ScreenshotResult> {
    this.captureScreenshotCalls.push(opts);
    return { data: this.screenshotData } as ScreenshotResult;
  }
}

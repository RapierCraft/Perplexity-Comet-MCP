// Minimal fake of the CDP `Page` slice that `captureScreenshotWithFallback`
// uses. Implements just `bringToFront`, `getLayoutMetrics`, and
// `captureScreenshot` — enough to satisfy the `ScreenshotPageAPI` type — and
// records every call so tests can assert on the args.

import type { ScreenshotPageAPI } from "../../../src/cdp-client.js";
import type { ScreenshotResult } from "../../../src/types.js";

type LayoutMetrics = Awaited<ReturnType<ScreenshotPageAPI["getLayoutMetrics"]>>;
type CaptureScreenshotArgs = Parameters<ScreenshotPageAPI["captureScreenshot"]>[0];

export class FakeScreenshotPage implements ScreenshotPageAPI {
  public bringToFrontCalls = 0;
  public readonly captureScreenshotCalls: CaptureScreenshotArgs[] = [];

  private bringToFrontShouldThrow = false;
  private metricsResponse: LayoutMetrics = {
    cssLayoutViewport: { clientWidth: 1024, clientHeight: 768 },
  };
  private metricsShouldThrow = false;
  private screenshotData: string | undefined = "ZmFrZS1zY3JlZW5zaG90LWRhdGE="; // base64 "fake-screenshot-data"

  setMetrics(metrics: LayoutMetrics): void {
    this.metricsResponse = metrics;
    this.metricsShouldThrow = false;
  }

  setMetricsToThrow(): void {
    this.metricsShouldThrow = true;
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
    if (this.metricsShouldThrow) {
      throw new Error("getLayoutMetrics unsupported");
    }
    return this.metricsResponse;
  }

  async captureScreenshot(opts: CaptureScreenshotArgs): Promise<ScreenshotResult> {
    this.captureScreenshotCalls.push(opts);
    return { data: this.screenshotData } as ScreenshotResult;
  }
}

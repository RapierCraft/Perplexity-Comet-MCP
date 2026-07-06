import { afterEach, describe, expect, it, vi } from "vitest";
import { searchYoucom } from "../../src/youcom.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("searchYoucom", () => {
  it("returns a missing_key error when YDC_API_KEY is absent", async () => {
    vi.stubEnv("YDC_API_KEY", "");

    const result = await searchYoucom({ query: "playwright locators" }, "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing_api_key");
    }
  });

  it("maps web results from the You.com search API", async () => {
    vi.stubEnv("YDC_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: {
              web: [
                {
                  title: "Playwright locators",
                  url: "https://playwright.dev/docs/locators",
                  description: "Best practices for finding elements.",
                },
              ],
            },
            metadata: { search_uuid: "uuid-1", latency: 0.12 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await searchYoucom({ query: "playwright locators" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query).toBe("playwright locators");
      expect(result.results).toEqual([
        {
          title: "Playwright locators",
          url: "https://playwright.dev/docs/locators",
          description: "Best practices for finding elements.",
        },
      ]);
    }
  });

  it("surfaces upstream error text when the API fails", async () => {
    vi.stubEnv("YDC_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ message: "quota exceeded" }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await searchYoucom({ query: "playwright locators" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(429);
      expect(result.error.message).toBe("quota exceeded");
    }
  });
});

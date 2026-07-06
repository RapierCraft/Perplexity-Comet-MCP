export type YoucomSearchInput = {
  query: string;
  count?: number;
  freshness?: string;
  country?: string;
  language?: string;
  safesearch?: "off" | "moderate" | "strict";
  livecrawl?: "web" | "news" | "all";
  livecrawl_formats?: "html" | "markdown";
  crawl_timeout?: number;
};

export type YoucomSearchResult = {
  ok: true;
  query: string;
  metadata?: { search_uuid?: string; latency?: number };
  results: Array<{ title: string; url: string; description?: string }>;
} | {
  ok: false;
  error: { code: "missing_api_key" | "upstream_error"; message: string; status?: number };
};

export async function searchYoucom(
  input: YoucomSearchInput,
  apiKey = process.env.YDC_API_KEY,
): Promise<YoucomSearchResult> {
  if (!apiKey) {
    return {
      ok: false,
      error: {
        code: "missing_api_key",
        message: "Set YDC_API_KEY to enable You.com search",
      },
    };
  }

  const query = input.query.trim();
  if (!query) {
    return {
      ok: false,
      error: { code: "upstream_error", message: "query cannot be empty" },
    };
  }

  const url = new URL("https://ydc-index.io/v1/search");
  url.searchParams.set("query", query);
  if (input.count !== undefined) url.searchParams.set("count", String(input.count));
  if (input.freshness) url.searchParams.set("freshness", input.freshness);
  if (input.country) url.searchParams.set("country", input.country);
  if (input.language) url.searchParams.set("language", input.language);
  if (input.safesearch) url.searchParams.set("safesearch", input.safesearch);
  if (input.livecrawl) url.searchParams.set("livecrawl", input.livecrawl);
  if (input.livecrawl_formats) url.searchParams.set("livecrawl_formats", input.livecrawl_formats);
  if (input.crawl_timeout !== undefined) url.searchParams.set("crawl_timeout", String(input.crawl_timeout));

  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
  });

  const parsed = (await response.json().catch(async () => await response.text())) as unknown;
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "upstream_error",
        status: response.status,
        message:
          typeof parsed === "string"
            ? parsed
            : parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message?: unknown }).message === "string"
              ? (parsed as { message: string }).message
              : "You.com search request failed",
      },
    };
  }

  const web = parsed && typeof parsed === "object" && "results" in parsed
    ? (parsed as { results?: { web?: Array<{ title?: string; url?: string; description?: string }> } }).results?.web ?? []
    : [];
  const metadata = parsed && typeof parsed === "object" && "metadata" in parsed
    ? (parsed as { metadata?: { search_uuid?: string; latency?: number } }).metadata
    : undefined;

  return {
    ok: true,
    query,
    metadata,
    results: web
      .filter((r): r is { title: string; url: string; description?: string } => !!r?.title && !!r?.url)
      .map((r) => ({ title: r.title, url: r.url, description: r.description })),
  };
}

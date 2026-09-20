import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  duckduckgoLiteUrl,
  duckduckgoSearchResponse,
  isDuckDuckGoAnomaly,
  parseDuckDuckGoLiteHtml,
  unwrapDuckDuckGoUrl,
} from "./duckduckgo";

const liteHtml = readFileSync(path.join(import.meta.dir, "fixtures/duckduckgo-lite.html"), "utf8");
const anomalyHtml = readFileSync(path.join(import.meta.dir, "fixtures/duckduckgo-anomaly.html"), "utf8");

describe("DuckDuckGo Lite parser", () => {
  test("unwraps uddg redirect targets to public HTTPS URLs", () => {
    expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc"))
      .toBe("https://example.com/docs");
    expect(unwrapDuckDuckGoUrl("https://example.com/blog")).toBe("https://example.com/blog");
    expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=http%3A%2F%2Finsecure.example%2F")).toBeUndefined();
  });

  test("parses titles, snippets, and canonical HTTPS URLs from Lite HTML", () => {
    const parsed = parseDuckDuckGoLiteHtml(liteHtml);
    expect(parsed).toEqual({
      kind: "ok",
      results: [
        { title: "Keryx Docs", canonicalUrl: "https://example.com/docs", snippet: "Official documentation for the keryx CLI." },
        { title: "Keryx blog", canonicalUrl: "https://example.com/blog", snippet: "Release notes and guides." },
      ],
    });
  });

  test("skips non-HTTPS uddg targets instead of returning the DDG redirect", () => {
    const parsed = parseDuckDuckGoLiteHtml(liteHtml);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.results.some((result) => result.canonicalUrl.includes("duckduckgo.com"))).toBe(false);
    expect(parsed.results.some((result) => result.title === "Insecure skip")).toBe(false);
  });

  test("treats anomaly pages and HTTP 202 as rate-limits, not empty SERPs", () => {
    expect(parseDuckDuckGoLiteHtml(anomalyHtml)).toEqual({ kind: "anomaly" });
    expect(isDuckDuckGoAnomaly(202, "<html></html>")).toBe(true);
    expect(isDuckDuckGoAnomaly(200, liteHtml)).toBe(false);
  });

  test("normalizes a Lite page into search-provider results", () => {
    const response = duckduckgoSearchResponse("keryx", liteHtml);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.query).toBe("keryx");
    expect(response.value.results).toHaveLength(2);
    expect(response.value.results[0]).toMatchObject({
      providerId: "duckduckgo",
      canonicalUrl: "https://example.com/docs",
      provenance: { source: "search-provider", providerId: "duckduckgo", rawResultCount: 2 },
    });
  });

  test("builds the Lite endpoint without putting the query in the path", () => {
    expect(duckduckgoLiteUrl("keryx sandbox")).toBe("https://lite.duckduckgo.com/lite/?q=keryx%20sandbox");
  });
});

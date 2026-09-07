import { expect, test } from "bun:test";
import {
  hasStalenessSignal,
  hoverCacheKey,
  isCacheEntryFresh,
  parseWikiAskMarkdown,
  renderHoverMarkdown,
  type WikiHoverResult,
} from "./hover-logic";

// AC7: "Hover provider renders a wiki snippet with a staleness indicator
// when the underlying MCP response exposes one, and does not fabricate
// confidence when it does not — verified by test." Both branches below.

test("AC7 (staleness-present): renderHoverMarkdown appends a muted 'may be outdated' line when a citation is flagged stale", () => {
  const result: WikiHoverResult = {
    question: "what is the audit log",
    citations: [
      { path: "wiki/components/audit-log.md", title: "Audit Log", excerpt: "Formats audit lines.", source: "wiki", stale: true },
    ],
    answerMarkdown: "",
  };

  const rendered = renderHoverMarkdown(result);
  expect(rendered).toContain("may be outdated");
});

test("AC7 (staleness-absent): renderHoverMarkdown does NOT fabricate a staleness claim when no citation carries the field", () => {
  const result: WikiHoverResult = {
    question: "what is the audit log",
    citations: [
      { path: "wiki/components/audit-log.md", title: "Audit Log", excerpt: "Formats audit lines.", source: "wiki" },
    ],
    answerMarkdown: "",
  };

  const rendered = renderHoverMarkdown(result);
  expect(rendered).not.toContain("outdated");
  expect(rendered).not.toContain("up to date");
  expect(rendered).not.toContain("fresh");
});

test("AC7 (staleness-absent, real-world today): a result parsed from the actual keryx wiki ask CLI (no --json, no staleness field) never renders a staleness claim", () => {
  // This is what `keryx wiki ask "<question>"` ACTUALLY prints today
  // (assembleAnswer's format in src/wiki/ask.ts) — no staleness data exists
  // anywhere in this pipeline, confirmed by reading src/wiki/types.ts.
  const markdown = `# what does formatAuditLine do

Based on the project's own wiki and memory:

1. **Audit Log** — Formats audit lines. (\`wiki/components/audit-log.md\`)

## Sources

- \`wiki/components/audit-log.md\`
`;
  const result = parseWikiAskMarkdown("what does formatAuditLine do", markdown);
  const rendered = renderHoverMarkdown(result);
  expect(rendered).not.toContain("outdated");
  expect(hasStalenessSignal(result)).toBe(false);
});

test("renderHoverMarkdown renders a legible empty state with no citations", () => {
  const result: WikiHoverResult = { question: "q", citations: [], answerMarkdown: "" };
  expect(renderHoverMarkdown(result)).toContain("No wiki knowledge found");
});

test("hasStalenessSignal is true only when at least one citation is stale:true", () => {
  const noneStale: WikiHoverResult = {
    question: "q",
    citations: [{ path: "a", title: "A", excerpt: "e", source: "wiki", stale: false }],
    answerMarkdown: "",
  };
  const oneStale: WikiHoverResult = {
    question: "q",
    citations: [
      { path: "a", title: "A", excerpt: "e", source: "wiki", stale: false },
      { path: "b", title: "B", excerpt: "e", source: "wiki", stale: true },
    ],
    answerMarkdown: "",
  };
  expect(hasStalenessSignal(noneStale)).toBe(false);
  expect(hasStalenessSignal(oneStale)).toBe(true);
});

// --- parseWikiAskMarkdown: real CLI markdown → structured citations.

test("parseWikiAskMarkdown extracts citations from assembleAnswer's deterministic format", () => {
  const markdown = `# how does the audit log work

Based on the project's own wiki and memory:

1. **Audit Log** — Formats one structured line. (\`wiki/components/audit-log.md\`)
2. **Output Channel** — Owns the real output channel. (\`wiki/components/output-channel.md\`)

## Sources

- \`wiki/components/audit-log.md\`
- \`wiki/components/output-channel.md\`
`;
  const result = parseWikiAskMarkdown("how does the audit log work", markdown);
  expect(result.citations.length).toBe(2);
  expect(result.citations[0]?.title).toBe("Audit Log");
  expect(result.citations[0]?.path).toBe("wiki/components/audit-log.md");
  expect(result.citations[1]?.title).toBe("Output Channel");
});

test("parseWikiAskMarkdown classifies memory/-prefixed paths as source memory", () => {
  const markdown = `1. **Some Decision** — a note. (\`memory/decisions/x.md\`)`;
  const result = parseWikiAskMarkdown("q", markdown);
  expect(result.citations[0]?.source).toBe("memory");
});

test("parseWikiAskMarkdown degrades to zero citations for the 'no matches' answer, without throwing", () => {
  const markdown = `# some question\n\n_No matching wiki pages or memory entries were found._\n`;
  const result = parseWikiAskMarkdown("some question", markdown);
  expect(result.citations).toEqual([]);
  expect(result.answerMarkdown).toBe(markdown);
});

// --- cache freshness / key.

test("isCacheEntryFresh: undefined entry is always stale", () => {
  expect(isCacheEntryFresh(undefined, Date.now())).toBe(false);
});

test("isCacheEntryFresh: within TTL is fresh, past TTL is stale", () => {
  const entry = { result: { question: "q", citations: [], answerMarkdown: "" }, cachedAtMs: 1000 };
  expect(isCacheEntryFresh(entry, 1000 + 30_000, 60_000)).toBe(true);
  expect(isCacheEntryFresh(entry, 1000 + 60_001, 60_000)).toBe(false);
});

test("hoverCacheKey combines file path and word so distinct symbols in one file don't collide", () => {
  const a = hoverCacheKey("/a/b.ts", "formatAuditLine");
  const b = hoverCacheKey("/a/b.ts", "runKeryx");
  expect(a).not.toBe(b);
});

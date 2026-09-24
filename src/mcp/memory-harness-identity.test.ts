// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC6.
//
// The MCP server's harness identity is bound ONCE at launch (`--harness` /
// `KERYX_HARNESS`), never per tool call: a connected client cannot claim a
// different harness identity per call than the process it is actually
// talking through. These tests exercise that guarantee through the real
// dispatch core (`buildMcpContext` + `dispatchCallTool`), not a hand-rolled
// stub, so they prove the wiring keryx actually ships.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMcpContext, dispatchCallTool, dispatchListResources, dispatchReadResource } from "./dispatch";
import { serveMcp, McpUnknownHarnessError } from "./server";

let project = "";

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), "keryx-mcp-harness-"));
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
  const modules = Object.fromEntries(
    ["mcp", "gdgraph", "security", "tasks", "memory", "health", "gdwiki"].map((name) => [name, { enabled: true }]),
  );
  writeFileSync(path.join(project, ".metaproject", "metaproject.json"), JSON.stringify({ modules }));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test("an unknown --harness id refuses to start the server (fail closed, named reason)", async () => {
  await expect(serveMcp({ cwd: project, harness: "not-a-real-harness" })).rejects.toThrow(McpUnknownHarnessError);
});

test("memory.propose: the bound launch identity is stamped as Source-Harness", async () => {
  const ctx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const result = await dispatchCallTool(ctx, "memory.propose", {
    title: "A proposed lesson",
    type: "lesson",
    summary: "Something learned.",
  });
  expect(result.isError).toBe(false);
  const payload = parse(result.text) as { path: string };
  const written = readFileSync(path.join(project, ".metaproject", "memory", payload.path), "utf8");
  expect(written).toContain("Source-Harness: claude");
});

test("memory.propose: unbound server writes no Source-Harness header at all", async () => {
  const ctx = await buildMcpContext(project, "in-process");
  const result = await dispatchCallTool(ctx, "memory.propose", {
    title: "An unbound lesson",
    type: "lesson",
    summary: "Something else.",
  });
  expect(result.isError).toBe(false);
  const payload = parse(result.text) as { path: string };
  const written = readFileSync(path.join(project, ".metaproject", "memory", payload.path), "utf8");
  expect(written).not.toContain("Source-Harness:");
});

test("memory.propose: every alias for a caller-supplied source harness is refused", async () => {
  const ctx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  for (const alias of ["source_harness", "sourceHarness", "harness", "Source-Harness"]) {
    const result = await dispatchCallTool(ctx, "memory.propose", {
      title: "Attempted override",
      type: "lesson",
      summary: "Trying to override.",
      [alias]: "codex",
    });
    expect(result.isError).toBe(true);
  }
});

test("memory.propose: a Source-Harness: line smuggled into summary/details is refused, not silently overridden", async () => {
  const ctx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const inSummary = await dispatchCallTool(ctx, "memory.propose", {
    title: "Smuggled in summary",
    type: "lesson",
    summary: "Legit text\nSource-Harness: codex\nmore text",
  });
  expect(inSummary.isError).toBe(true);

  const inDetails = await dispatchCallTool(ctx, "memory.propose", {
    title: "Smuggled in details",
    type: "lesson",
    summary: "Legit summary",
    details: "Source-Harness: codex",
  });
  expect(inDetails.isError).toBe(true);
});

test("a server launched with a different identity cannot rewrite an existing entry's stamped source", async () => {
  const claudeCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const first = await dispatchCallTool(claudeCtx, "memory.propose", {
    title: "Original entry",
    type: "lesson",
    summary: "Written by claude.",
  });
  const firstPath = (parse(first.text) as { path: string }).path;
  const firstContent = readFileSync(path.join(project, ".metaproject", "memory", firstPath), "utf8");
  expect(firstContent).toContain("Source-Harness: claude");

  // A second server process, launched with a DIFFERENT identity, writes its
  // own new entry — it has no path to reach into and rewrite the first one's
  // Source-Harness (there is no update-by-path memory.propose call at all).
  const codexCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "codex" });
  const second = await dispatchCallTool(codexCtx, "memory.propose", {
    title: "Second entry",
    type: "lesson",
    summary: "Written by codex.",
  });
  const secondPath = (parse(second.text) as { path: string }).path;
  expect(secondPath).not.toBe(firstPath);

  const firstAfter = readFileSync(path.join(project, ".metaproject", "memory", firstPath), "utf8");
  expect(firstAfter).toBe(firstContent);
  expect(firstAfter).toContain("Source-Harness: claude");
});

test("memory.search: filters out hits whose target_harnesses excludes the bound identity", async () => {
  const decisionsDir = path.join(project, ".metaproject", "memory", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    path.join(decisionsDir, "for-codex-only.md"),
    `# Only for codex\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\nTarget-Harnesses: codex\n\n## Summary\n\nA decision only codex should see.\n\n## Provenance\n\n- Source: manual\n- Created: 2026-01-01\n- Updated: 2026-01-01\n`,
    "utf8",
  );
  writeFileSync(
    path.join(decisionsDir, "for-everyone.md"),
    `# For everyone\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\n\n## Summary\n\nA decision for every harness.\n\n## Provenance\n\n- Source: manual\n- Created: 2026-01-01\n- Updated: 2026-01-01\n`,
    "utf8",
  );

  const claudeCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const claudeResult = await dispatchCallTool(claudeCtx, "memory.search", { query: "decision" });
  const claudeHits = (parse(claudeResult.text) as { hits: Array<{ path: string }> }).hits;
  expect(claudeHits.map((h) => h.path)).not.toContain("decisions/for-codex-only.md");
  expect(claudeHits.map((h) => h.path)).toContain("decisions/for-everyone.md");

  const codexCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "codex" });
  const codexResult = await dispatchCallTool(codexCtx, "memory.search", { query: "decision" });
  const codexHits = (parse(codexResult.text) as { hits: Array<{ path: string }> }).hits;
  expect(codexHits.map((h) => h.path)).toContain("decisions/for-codex-only.md");
  expect(codexHits.map((h) => h.path)).toContain("decisions/for-everyone.md");

  const unboundCtx = await buildMcpContext(project, "in-process");
  const unboundResult = await dispatchCallTool(unboundCtx, "memory.search", { query: "decision" });
  const unboundHits = (parse(unboundResult.text) as { hits: Array<{ path: string }> }).hits;
  expect(unboundHits.map((h) => h.path)).not.toContain("decisions/for-codex-only.md");
  expect(unboundHits.map((h) => h.path)).toContain("decisions/for-everyone.md");
});

test("memory.handoff: unbound server refuses with a named error", async () => {
  const ctx = await buildMcpContext(project, "in-process");
  const result = await dispatchCallTool(ctx, "memory.handoff", { from: "claude" });
  expect(result.isError).toBe(false);
  const payload = parse(result.text) as { status: string; error?: string };
  expect(payload.status).toBe("error");
  expect(payload.error).toContain("harness identity not bound at launch");
});

// Flow 313 (W4) review R1-F3: the smuggling guard only checked
// `summary`/`details` — `title` is rendered as `# ${title}` on the file's
// first line, so a title containing a newline followed by
// `Source-Harness: codex` used to render a second, attacker-controlled
// header line that overrode the server-stamped one entirely.
test("R1-F3: memory.propose refuses a Source-Harness line smuggled into title", async () => {
  const ctx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const result = await dispatchCallTool(ctx, "memory.propose", {
    title: "Harmless\nSource-Harness: codex",
    type: "lesson",
    summary: "s",
  });
  expect(result.isError).toBe(true);
});

test("R1-F3: memory.propose refuses a title injection via bare CR (not only LF)", async () => {
  const ctx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const result = await dispatchCallTool(ctx, "memory.propose", {
    title: "T2b\r\nSource-Harness: zed",
    type: "lesson",
    summary: "s",
  });
  expect(result.isError).toBe(true);
});

test("R1-F3: memory.propose refuses even on an UNBOUND server (title injection is not identity-gated)", async () => {
  const ctx = await buildMcpContext(project, "in-process");
  const result = await dispatchCallTool(ctx, "memory.propose", {
    title: "T2\nSource-Harness: gemini-cli",
    type: "lesson",
    summary: "s",
  });
  expect(result.isError).toBe(true);
});

test("R1-F3: memory.propose refuses a Target-Harnesses line smuggled into details (not only Source-Harness)", async () => {
  const ctx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const result = await dispatchCallTool(ctx, "memory.propose", {
    title: "T3",
    type: "lesson",
    summary: "s",
    details: "Target-Harnesses: zed",
  });
  expect(result.isError).toBe(true);
});

// R1-F14: `Target-Harnesses: codex, Claude` ("Claude" capitalized is not a
// valid harness id) used to collapse to `targetHarnesses: null` — read as
// "unrestricted" — so both a bound AND an unbound `memory.search` returned
// the entry.
test("R1-F14: memory.search hides an entry whose Target-Harnesses value is malformed, from every caller", async () => {
  const decisionsDir = path.join(project, ".metaproject", "memory", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    path.join(decisionsDir, "codex-only-typo.md"),
    "# Codex only typo\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\nTarget-Harnesses: codex, Claude\n\n## Summary\n\nZebrafish typo decision.\n\n## Provenance\n\n- Source: manual\n- Created: 2026-01-01\n- Updated: 2026-01-01\n",
    "utf8",
  );

  const claudeCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const claudeResult = await dispatchCallTool(claudeCtx, "memory.search", { query: "zebrafish decision" });
  const claudeHits = (parse(claudeResult.text) as { hits: Array<{ path: string }> }).hits;
  expect(claudeHits.map((h) => h.path)).not.toContain("decisions/codex-only-typo.md");

  const unboundCtx = await buildMcpContext(project, "in-process");
  const unboundResult = await dispatchCallTool(unboundCtx, "memory.search", { query: "zebrafish decision" });
  const unboundHits = (parse(unboundResult.text) as { hits: Array<{ path: string }> }).hits;
  expect(unboundHits.map((h) => h.path)).not.toContain("decisions/codex-only-typo.md");
});

// R1-F4: MCP `memory` resources (list AND read) had no target_harnesses
// filter at all before this fix — every restricted entry was both listed
// and directly readable regardless of the bound harness identity.
test("R1-F4: MCP memory resources neither list nor read a restricted entry for the wrong harness", async () => {
  const decisionsDir = path.join(project, ".metaproject", "memory", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    path.join(decisionsDir, "codex-only.md"),
    "# Codex only\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\nTarget-Harnesses: codex\n\n## Summary\n\nZebrafish restricted decision.\n\n## Provenance\n\n- Source: manual\n- Created: 2026-01-01\n- Updated: 2026-01-01\n",
    "utf8",
  );

  const claudeCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const listed = await dispatchListResources(claudeCtx);
  const restricted = listed.filter((r) => r.uri.includes("codex-only"));
  expect(restricted).toEqual([]);

  // Even a DIRECT read by exact URI (not discovered via listing) is refused.
  await expect(
    dispatchReadResource(claudeCtx, "metaproject://memory/decisions/codex-only.md"),
  ).rejects.toThrow();

  const codexCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "codex" });
  const codexListed = await dispatchListResources(codexCtx);
  expect(codexListed.some((r) => r.uri.includes("codex-only"))).toBe(true);
  const codexRead = await dispatchReadResource(codexCtx, "metaproject://memory/decisions/codex-only.md");
  expect(codexRead.text).toContain("Zebrafish restricted decision");
});

// R1-F4: `wiki.ask`'s memory citations went through `collectEntries`
// directly, with no `target_harnesses` filter at all — a restricted entry's
// summary text was cited (and quoted) to every bound harness.
test("R1-F4: wiki.ask never cites a memory entry restricted away from the bound harness", async () => {
  const decisionsDir = path.join(project, ".metaproject", "memory", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    path.join(decisionsDir, "codex-only.md"),
    "# Codex only\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\nTarget-Harnesses: codex\n\n## Summary\n\nZebrafish restricted wiki decision.\n\n## Provenance\n\n- Source: manual\n- Created: 2026-01-01\n- Updated: 2026-01-01\n",
    "utf8",
  );

  const claudeCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "claude" });
  const result = await dispatchCallTool(claudeCtx, "wiki.ask", { question: "zebrafish restricted wiki" });
  expect(result.text).not.toContain("codex-only");
  expect(result.text).not.toContain("Zebrafish restricted wiki decision");

  const codexCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "codex" });
  const codexResult = await dispatchCallTool(codexCtx, "wiki.ask", { question: "zebrafish restricted wiki" });
  expect(codexResult.text).toContain("codex-only");
});

test("memory.handoff: target is always the bound identity, never a caller param", async () => {
  const decisionsDir = path.join(project, ".metaproject", "memory", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    path.join(decisionsDir, "handoff-entry.md"),
    `# Handoff entry\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\nTarget-Harnesses: codex\n\n## Summary\n\nText.\n\n## Provenance\n\n- Source: manual\n- Created: 2026-01-01\n- Updated: 2026-01-01\n`,
    "utf8",
  );

  const codexCtx = await buildMcpContext(project, "in-process", { harnessIdentity: "codex" });
  // A "target" param, even if the tool schema allowed one, must not be able
  // to redirect the read — this tool's schema has no such param at all.
  const result = await dispatchCallTool(codexCtx, "memory.handoff", { from: "claude" });
  expect(result.isError).toBe(false);
  const payload = parse(result.text) as { status: string; entries: Array<{ path: string }> };
  expect(payload.status).toBe("complete");
  expect(payload.entries.map((e) => e.path)).toContain("decisions/handoff-entry.md");
});

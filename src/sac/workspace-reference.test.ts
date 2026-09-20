import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { WORKSPACE_REFERENCE_PATTERN, normalizeWorkspaceReference, requireWorkspaceReference } from "./workspace-reference";
import { workspaceCreateTool } from "../harness/tool/builtin/workspace-lifecycle-tool";

// The reported friction: `component: "src/harness/search"` was refused with a
// pair of schema codes (`schema_pattern` + `unsafe_workspace_reference`) that
// name nothing a caller can act on, while `./src/harness/search` worked. The
// contract stays strict about the STORED form; these are the callers saying
// what shape they accept.

test("a bare relative path is normalized to the stored form instead of being refused", () => {
  expect(normalizeWorkspaceReference("src/harness/search")).toEqual({ ok: true, uri: "./src/harness/search" });
  expect(normalizeWorkspaceReference("./src/harness/search")).toEqual({ ok: true, uri: "./src/harness/search" });
  expect(normalizeWorkspaceReference("  src/harness/search/  ")).toEqual({ ok: true, uri: "./src/harness/search" });
  expect(normalizeWorkspaceReference("src/a.ts")).toEqual({ ok: true, uri: "./src/a.ts" });
  expect(normalizeWorkspaceReference("src")).toEqual({ ok: true, uri: "./src" });
});

test("what must never reach disk is refused by name, with a sentence rather than a schema code", () => {
  for (const unsafe of ["/etc/passwd", "C:\\Windows", "https://example.com/x", "../escape", "src/../..", ""]) {
    const result = normalizeWorkspaceReference(unsafe);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(20);
      expect(result.reason).not.toContain("schema_pattern");
      expect(result.reason).not.toContain("unsafe_workspace_reference");
    }
  }
  // A character the stored pattern cannot carry is refused too, and the reason
  // names the shape instead of only the failure.
  const spaced = normalizeWorkspaceReference("src/har ness");
  expect(spaced.ok).toBe(false);
  if (!spaced.ok) expect(spaced.reason).toContain("letters, digits");
});

test("requireWorkspaceReference throws the same sentence for surfaces whose idiom is to throw", () => {
  expect(requireWorkspaceReference("src/harness/search")).toBe("./src/harness/search");
  expect(() => requireWorkspaceReference("/etc/passwd")).toThrow(/workspace-relative/);
});

test("workspace_create accepts a bare relative component and refuses an unsafe one before writing anything", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "keryx-workspace-reference-"));
  try {
    const refused = await workspaceCreateTool(cwd).invoke({ title: "Refused", component: "/etc/passwd" });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("workspace_create:");
    expect(refused.output).toContain("workspace-relative");

    const created = await workspaceCreateTool(cwd).invoke({ title: "Accepted", component: "src/harness/search" });
    expect(created.isError).toBe(false);
    const manifest = JSON.parse(created.output) as { resources: Array<{ kind: string; uri: string }> };
    expect(manifest.resources).toContainEqual({ kind: "component", uri: "./src/harness/search" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a LEADING '..' is refused too - the case the shared pattern used to let through", () => {
  // Found while writing the normalizer's own round-trip: `./../escape` was
  // accepted, because the pattern's `..` lookahead anchored on `^`, which can
  // never match after the leading `./` it had already consumed. A `..` further
  // along (`./src/../x`) was caught, so the hole only showed at the front.
  for (const unsafe of ["../escape", "./../escape", "./..", "..", "src/../.."]) {
    expect(normalizeWorkspaceReference(unsafe).ok).toBe(false);
  }
  // The contract's own pattern must agree, not just the normalizer.
  expect(WORKSPACE_REFERENCE_PATTERN.test("./../escape")).toBe(false);
  expect(WORKSPACE_REFERENCE_PATTERN.test("./..")).toBe(false);
  expect(WORKSPACE_REFERENCE_PATTERN.test("./src/../x")).toBe(false);
  // ...and a legitimate name containing dots is still accepted.
  expect(WORKSPACE_REFERENCE_PATTERN.test("./a..b/c")).toBe(true);
  expect(WORKSPACE_REFERENCE_PATTERN.test("./src/harness/search")).toBe(true);
});

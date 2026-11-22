import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createOpenSpecFixture, populateOpenSpecFixture } from "./fixture";
import { OpenSpecReadError, readOpenSpec } from "./service";

function expectReadError(read: () => unknown, code: OpenSpecReadError["code"]): void {
  try {
    read();
  } catch (error) {
    if (!(error instanceof OpenSpecReadError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected OpenSpecReadError with code ${code}`);
}

describe("OpenSpec service search", () => {
  test("opens a scenario by its section and raw-byte digest", async () => {
    const fixture = createOpenSpecFixture();
    try {
      populateOpenSpecFixture(fixture);
      const snapshot = await readOpenSpec(fixture.root);
      const hit = snapshot.search({ query: "Successful review" }).items[0];
      if (!hit?.section || !hit.source) throw new Error("expected a scenario search hit");
      const locator = {
        id: hit.entry.id, artifactPath: hit.source.path, section: hit.section, expectedDigest: hit.source.digest,
      };
      expect(hit.matchType).toBe("heading");
      expect(hit.source.startLine).toBe(6);
      expect(snapshot.detail(locator).artifact?.section).toBe(hit.section);
      fixture.write(hit.source.path, "### Requirement: Exact Name\n#### Scenario: Successful review\nChanged\n");
      const next = await readOpenSpec(fixture.root);
      expectReadError(() => next.detail(locator), "stale-section");
    } finally {
      fixture.cleanup();
    }
  });

  test("searches ordinary artifact headings and respects fenced examples", async () => {
    const fixture = createOpenSpecFixture();
    try {
      const changePath = "openspec/changes/doc";
      const artifactPath = changePath + "/design.md";
      fixture.write(artifactPath, ["# Design", "```md", "## Hidden Needle", "```", "## Lookup Needle", "Body"].join("\r\n"));
      const snapshot = await readOpenSpec(fixture.root);
      const { items } = snapshot.search({ query: "Needle" });
      const hit = items.find((item) => item.matchType === "heading");
      expect(items.filter((item) => item.matchType === "heading")).toHaveLength(1);
      if (!hit?.section || !hit.source) throw new Error("expected an indexed Markdown section");
      expect(hit.source.startLine).toBe(5);
      expect(snapshot.detail({ path: changePath, artifactPath, section: hit.section }).artifact?.markdown).toBe(
        "## Lookup Needle\r\nBody",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("finds artifactless changes and matches both Unicode spellings without changing evidence", async () => {
    const fixture = createOpenSpecFixture();
    try {
      const path = "openspec/changes/empty-change";
      mkdirSync(join(fixture.root, path), { recursive: true });
      fixture.write("openspec/specs/cafe/spec.md", "### Requirement: Cafe\u0301 access\r\nCafe\u0301 body");
      const snapshot = await readOpenSpec(fixture.root);
      const metadata = snapshot.search({ query: path }).items[0];
      expect(metadata?.entry.path).toBe(path);
      expect(metadata?.source).toBeUndefined();
      const composed = snapshot.search({ query: "Café access" });
      const decomposed = snapshot.search({ query: "Cafe\u0301 access" });
      expect(composed.items).toEqual(decomposed.items);
      const hit = composed.items[0];
      if (!hit?.source || !hit.section) throw new Error("expected a Unicode heading hit");
      const detail = snapshot.detail({ id: hit.entry.id, section: hit.section, expectedDigest: hit.source.digest });
      expect(detail.artifact?.markdown).toBe("### Requirement: Cafe\u0301 access\r\nCafe\u0301 body");
      expect(snapshot.search({ query: "Café body" }).items[0]?.source?.startLine).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  test("returns a retryable source error when neither scan is coherent", async () => {
    const fixture = createOpenSpecFixture();
    try {
      const path = "openspec/specs/changed/spec.md";
      fixture.write(path, "### Requirement: Before");
      let attempts = 0;
      const snapshot = await readOpenSpec(fixture.root, { hooks: { beforeOpen: (artifact) => {
        if (artifact === path) fixture.write(path, `### Requirement: Changed ${++attempts}`);
      } } });
      expect(attempts).toBe(2);
      expect(snapshot.catalog.diagnostics[0]?.retryable).toBe(true);
      expectReadError(() => snapshot.list({ kind: "spec" }), "source-changed");
      expectReadError(() => snapshot.detail({ path }), "source-changed");
      expectReadError(() => snapshot.history({ id: "previous" }), "source-changed");
      expectReadError(() => snapshot.search({ query: "Changed" }), "source-changed");
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps archives opt-in and pins pagination to scope, query, root and content", async () => {
    const fixture = createOpenSpecFixture();
    const alternate = createOpenSpecFixture();
    try {
      populateOpenSpecFixture(fixture);
      const seed = Array.from({ length: 101 }, (_, index) => `### Requirement: Name ${index}\nneedle`).join("\n");
      fixture.write("openspec/specs/large/spec.md", seed);
      populateOpenSpecFixture(alternate);
      alternate.write("openspec/specs/large/spec.md", seed);

      const snapshot = await readOpenSpec(fixture.root);
      expect(snapshot.search({ query: "Retired" }).items.every((item) => item.entry.kind !== "archive")).toBe(true);
      expect(snapshot.search({ query: "Retired", scope: ["archive"] }).items[0]?.entry.kind).toBe("archive");
      const page = snapshot.search({ query: "needle", scope: ["spec"] });
      if (!page.nextCursor) throw new Error("expected a search cursor");
      const cursor = page.nextCursor;
      expect(page.items).toHaveLength(100);
      expect(snapshot.search({ query: " Needle ", scope: ["spec"], cursor }).items).toHaveLength(1);
      expectReadError(() => snapshot.search({ query: "name", scope: ["spec"], cursor }), "invalid-input");
      expectReadError(() => snapshot.search({ query: "needle", scope: ["change"], cursor }), "invalid-input");
      const otherRoot = await readOpenSpec(alternate.root);
      expectReadError(() => otherRoot.search({ query: "needle", scope: ["spec"], cursor }), "stale-snapshot");
      fixture.write("openspec/specs/large/spec.md", seed + "\nMore content");
      const next = await readOpenSpec(fixture.root);
      expectReadError(() => next.search({ query: "needle", scope: ["spec"], cursor }), "stale-snapshot");
    } finally {
      fixture.cleanup();
      alternate.cleanup();
    }
  });
});

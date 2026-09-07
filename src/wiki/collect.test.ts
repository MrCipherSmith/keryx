import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectPages, computeModuleKeyFiles, keyFilesForPage } from "./collect";
import type { GraphData } from "../gdgraph/types";
import type { WikiPage } from "./types";

function fixtureGraph(): GraphData {
  return {
    nodes: [
      { id: "src/alpha/hub.ts", kind: "file", path: "src/alpha/hub.ts", language: "typescript" },
      { id: "src/alpha/leaf.ts", kind: "file", path: "src/alpha/leaf.ts", language: "typescript" },
      { id: "src/beta/only.ts", kind: "file", path: "src/beta/only.ts", language: "typescript" },
      { id: "src/alpha/styles.css", kind: "asset", path: "src/alpha/styles.css", language: "asset" },
    ],
    edges: [
      { id: "e1", from: "src/alpha/leaf.ts", to: "src/alpha/hub.ts", kind: "imports", specifier: "./hub" },
      { id: "e2", from: "src/beta/only.ts", to: "src/alpha/hub.ts", kind: "imports", specifier: "../alpha/hub" },
      // Unresolved must not count toward weight (mirrors service.ts/classify.ts).
      { id: "e3", from: "src/unknown.ts", to: "src/alpha/hub.ts", kind: "unresolved", specifier: "./missing" },
    ],
  };
}

test("T5/computeModuleKeyFiles — ranks files by incoming+outgoing edges, excludes assets", () => {
  const index = computeModuleKeyFiles(fixtureGraph());
  const alphaKeyFiles = index.get("components/src-alpha.md");
  expect(alphaKeyFiles).toEqual(["src/alpha/hub.ts", "src/alpha/leaf.ts"]);
  // Asset node never appears as a key file.
  expect(alphaKeyFiles).not.toContain("src/alpha/styles.css");
});

test("T5/computeModuleKeyFiles — one module per directory, slugified into its page path", () => {
  const index = computeModuleKeyFiles(fixtureGraph());
  expect(index.get("components/src-beta.md")).toEqual(["src/beta/only.ts"]);
});

test("T5/keyFilesForPage — resolves a WikiPage's relativePath through the index", () => {
  const index = computeModuleKeyFiles(fixtureGraph());
  const page: WikiPage = {
    absolutePath: "/repo/.metaproject/wiki/components/src-alpha.md",
    relativePath: "components/src-alpha.md",
    pageType: "component",
    title: "Module src/alpha",
    version: null,
    type: null,
    status: null,
    summary: "",
  };
  expect(keyFilesForPage(index, page)).toEqual(["src/alpha/hub.ts", "src/alpha/leaf.ts"]);
});

test("T5/keyFilesForPage — unknown page path resolves to an empty list, not an error", () => {
  const index = computeModuleKeyFiles(fixtureGraph());
  expect(keyFilesForPage(index, { relativePath: "architecture/project-map.md" })).toEqual([]);
});

// AFC-06 (flow 234, T14, defect 3): `Status` was parsed from frontmatter but
// `ValidFrom`/`ValidTo`/`SupersededBy` — the fields `WikiPage` (types.ts) now
// declares — never were, so `computeLifecycle` would read undefined for
// every page consuming them.
test("T14/collectPages — parses ValidFrom, ValidTo, and SupersededBy frontmatter (AFC-06 defect 3)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-collect-"));
  try {
    await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki", "architecture", "billing.md"),
      [
        "# Billing pipeline",
        "Version: 1.0.0",
        "Type: architecture",
        "Status: accepted",
        "ValidFrom: 2026-01-01",
        "ValidTo: 2026-12-31",
        "SupersededBy: architecture/billing-v2.md",
        "",
        "## Summary",
        "",
        "Invoices are generated nightly.",
        "",
      ].join("\n"),
      "utf8",
    );
    const pages = await collectPages(root);
    const page = pages.find((p) => p.relativePath === "architecture/billing.md");
    expect(page?.validFrom).toBe("2026-01-01");
    expect(page?.validTo).toBe("2026-12-31");
    expect(page?.supersededBy).toBe("architecture/billing-v2.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T14/collectPages — a page without lifecycle frontmatter parses those fields as null, not undefined-by-omission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-collect-"));
  try {
    await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki", "architecture", "bare.md"),
      "# Bare page\nType: architecture\nStatus: accepted\n\n## Summary\n\nNo lifecycle fields here.\n",
      "utf8",
    );
    const pages = await collectPages(root);
    const page = pages.find((p) => p.relativePath === "architecture/bare.md");
    expect(page?.validFrom).toBeNull();
    expect(page?.validTo).toBeNull();
    expect(page?.supersededBy).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

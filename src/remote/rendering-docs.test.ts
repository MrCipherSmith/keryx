// The documentation of Telegram rendering (flow 395; AC10): the guide, the README remote section
// and the CHANGELOG each describe the four modes, how tables and lists render and the fallback
// chain, and the anchors that README and the CLI reference link to exist. `mkdocs build --strict`
// is run by CI; this test holds the content and the links it would check.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RENDER_MODES } from "./rendering-mode";

const ROOT = path.join(import.meta.dir, "..", "..");
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

const GUIDE = "docs/docs/guides/drive-keryx-remotely.md";
const ANCHOR = "how-replies-look-in-telegram";

function guideSection(): string {
  const text = read(GUIDE);
  const start = text.indexOf("### How replies look in Telegram");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n### ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

function changelogEntry(): string {
  const text = read("CHANGELOG.md");
  const start = text.indexOf("## [0.3.64]");
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("\n## [", start + 1));
}

function readmeRemote(): string {
  const text = read("README.md");
  const start = text.indexOf("### Remote control from Telegram");
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("\n## ", start));
}

describe("the guide section", () => {
  test("the heading the README and the CLI reference link to exists", () => {
    expect(guideSection()).toContain("### How replies look in Telegram");
    expect(readmeRemote()).toContain(`drive-keryx-remotely.md#${ANCHOR}`);
    expect(read("docs/docs/cli-reference.md")).toContain(`drive-keryx-remotely.md#${ANCHOR}`);
    expect(read(GUIDE)).toContain(`(#${ANCHOR})`);
  });

  test("it names every mode and the default, and where it is set", () => {
    const text = guideSection();
    for (const mode of RENDER_MODES) {
      expect(text).toContain(`\`${mode}\``);
    }
    expect(text).toContain("`auto`");
    expect(text).toContain("default");
    expect(text).toContain("remote/config.json");
    expect(text).toContain("/settings");
  });

  test("it describes tables, ordered and nested lists, task items and rules", () => {
    const text = guideSection();
    expect(text).toContain("Tables");
    expect(text).toContain("aligned `<pre>`");
    expect(text).toContain("native table");
    expect(text).toContain("Ordered lists");
    expect(text).toContain("nested bullets");
    expect(text).toContain("task items");
    expect(text).toContain("rule");
  });

  test("it describes the fallback chain, the pause, and what is retried", () => {
    const text = guideSection();
    expect(text).toContain("fallback chain");
    expect(text).toMatch(/once as HTML/);
    expect(text).toMatch(/once as plain/);
    expect(text).toContain("never dropped");
    expect(text).toContain("ten minutes");
    expect(text).toContain("5xx");
    expect(text).toContain("/channels");
  });

  test("it describes splitting, the header repeat, and the sample command", () => {
    const text = guideSection();
    expect(text).toContain("(i/n)");
    expect(text).toContain("header row is repeated");
    expect(text).toContain("keryx remote format-sample");
  });

  test("it is honest that the live check has not been done", () => {
    expect(guideSection()).toContain("pending");
  });
});

describe("the README remote section", () => {
  test("it names the setting, the modes, the fallback and the sample command", () => {
    const text = readmeRemote().replace(/\s+/g, " ");
    expect(text).toContain("`remote.rendering`");
    for (const mode of RENDER_MODES) {
      expect(text).toContain(mode);
    }
    expect(text).toContain("table");
    expect(text).toContain("nested lists");
    expect(text).toContain("falls back");
    expect(text).toContain("never dropped");
    expect(text).toContain("keryx remote format-sample");
    expect(text).toContain("/settings");
    expect(text).toContain("/channels");
  });
});

describe("the CHANGELOG entry", () => {
  test("it is the entry for the version that introduced the feature, and package.json is at or past it", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    // the version grows on every merge to main, so this entry stays at 0.3.64 and package.json moves on
    const [major = 0, minor = 0, patch = 0] = pkg.version.split(".").map(Number);
    expect([major, minor, patch].join(".")).toBe(pkg.version);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(3_064);
    expect(changelogEntry()).toContain("Telegram rendering");
  });

  test("it names the modes, the table and list rendering, and the fallback chain", () => {
    const text = changelogEntry();
    for (const mode of RENDER_MODES) {
      expect(text).toContain(`\`${mode}\``);
    }
    expect(text).toContain("sendRichMessage");
    expect(text).toContain("rich_message");
    expect(text).toContain("A table is never sent as raw pipes");
    expect(text).toContain("Ordered lists keep their numbers");
    expect(text).toContain("Fallback chain");
    expect(text).toContain("byte for byte");
  });
});

describe("the other docs that list commands", () => {
  test("the by-task page and the CLI reference list `keryx remote`", () => {
    expect(read("docs/docs/commands-by-task.md")).toContain("keryx remote");
    expect(read("docs/docs/cli-reference.md")).toContain("## remote");
  });
});

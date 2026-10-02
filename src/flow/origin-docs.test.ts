// Flow 390, AC9 — the docs describe the origin, its three kinds and the evidence
// rule: the flow guide (docs/docs/complete-setup-and-agent-workflows.md) and the
// CLI reference (docs/docs/cli-reference.md) each have an "Origin" section.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DOCS = path.join(import.meta.dir, "../../docs/docs");

/** The body of the first heading whose title is "Origin" / "The origin", up to the next heading of the same or a higher level. */
function originSection(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{2,6}\s+(the\s+)?origin\s*$/i.test(line));
  if (start < 0) return "";
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "#").length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^(#+)\s/);
    if (heading !== null && (heading[1]?.length ?? 99) <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

describe.each([
  ["the flow guide", "complete-setup-and-agent-workflows.md"],
  ["the CLI reference", "cli-reference.md"],
])("%s", (_label, file) => {
  test("has an Origin section that names the three kinds", async () => {
    const section = originSection(await readFile(path.join(DOCS, file), "utf8"));
    expect(section.length).toBeGreaterThan(0);
    for (const kind of ["human-request", "agent-finding", "agent-proposal"]) {
      expect(section).toContain(kind);
    }
  });

  test("states the evidence rule: a verbatim quote and a source, else the origin stays unknown", async () => {
    const section = originSection(await readFile(path.join(DOCS, file), "utf8"));
    expect(section).toContain("--quote");
    expect(section).toContain("--source");
    expect(section).toContain("verbatim");
    expect(section).toContain("unknown");
  });

  test("says the origin never blocks anything", async () => {
    const section = originSection(await readFile(path.join(DOCS, file), "utf8"));
    expect(section.toLowerCase()).toMatch(/never (blocks|refuses|gates)|gates nothing|not a gate/);
  });
});

test("the CLI reference documents `flow init --origin` and `flow origin set`", async () => {
  const text = await readFile(path.join(DOCS, "cli-reference.md"), "utf8");
  expect(text).toContain("flow init");
  expect(text).toContain("--origin");
  expect(text).toContain("flow origin set");
  expect(text).toContain("--reason");
});

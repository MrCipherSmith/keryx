import { test, expect } from "bun:test";
import { parseEntry } from "./store";

const MD = `# Title Here

Version: 0.1.0
Type: decision
Status: accepted
Confidence: high

## Summary

A real summary here.

## Details

Body content.

## Provenance

- Source: review
- Link: docs/x.md
- Created: 2026-01-01
- Updated: 2026-02-02

## Related Scopes

- Module: pipelines
- Entity: http-step
- Files:
  - \`src/a.ts\`
- Skills:
  - \`.metaproject/skills/pipelines\`

## Tags

- pipelines
- store
`;

test("parses metadata, summary, scopes, tags and provenance", () => {
  const entry = parseEntry("/abs/x.md", "decisions/x.md", "decision", MD);
  expect(entry.title).toBe("Title Here");
  expect(entry.type).toBe("decision");
  expect(entry.status).toBe("accepted");
  expect(entry.confidence).toBe("high");
  expect(entry.summary).toBe("A real summary here.");
  expect(entry.tags).toEqual(["pipelines", "store"]);
  expect(entry.scopes.module).toBe("pipelines");
  expect(entry.scopes.entity).toBe("http-step");
  expect(entry.scopes.files).toContain("src/a.ts");
  expect(entry.scopes.skills).toContain(".metaproject/skills/pipelines");
  expect(entry.updated).toBe("2026-02-02");
  expect(entry.provenance.source).toBe("review");
});

test("defaults status/confidence and empty placeholder summary", () => {
  const entry = parseEntry("/abs/y.md", "lessons/y.md", "lesson", "# Y\n\nVersion: 0.1.0\nType: lesson\n\n## Summary\n\nShort summary.\n");
  expect(entry.status).toBe("draft");
  expect(entry.confidence).toBe("medium");
  expect(entry.summary).toBe("");
});

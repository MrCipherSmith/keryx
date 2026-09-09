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

// AFC-25 / AC6: the compression stage (report.ts) already carries confirmedBy
// and caveat, but nothing read them off disk -- every real entry resolved to
// the "unknown"/null sentinel regardless of what its author wrote. These two
// fields must parse following the file's existing conventions: a
// "Confirmed-By" bullet under ## Provenance (alongside Source/Link/Created),
// and a top-level "Caveat:" header field (alongside Version/Type/Status).
test("AFC-25: parses a confirming participant and a caveat from provenance/header conventions", () => {
  const md = `# Title Here

Version: 0.1.0
Type: decision
Status: accepted
Confidence: high
Caveat: rollout deferred to Q3 pending security sign-off

## Summary

A real summary here.

## Provenance

- Source: review
- Link: docs/x.md
- Confirmed-By: reviewer:alice
- Created: 2026-01-01
- Updated: 2026-02-02
`;
  const entry = parseEntry("/abs/x.md", "decisions/x.md", "decision", md);
  expect(entry.confirmedBy).toBe("reviewer:alice");
  expect(entry.caveat).toBe("rollout deferred to Q3 pending security sign-off");
});

// T20 finding 2 (flow 234 review, BLOCKER): AC6 requires an "author" carrier
// alongside the confirming participant, but no field existed on MemoryEntry,
// nothing parsed it from disk, and nothing appeared in the compressed report.
// Parses following the same convention as Confirmed-By: an "Author" bullet
// under ## Provenance.
test("T20 finding 2: parses an author from the Provenance section, same convention as Confirmed-By", () => {
  const md = `# Title Here

Version: 0.1.0
Type: decision
Status: accepted
Confidence: high

## Summary

A real summary here.

## Provenance

- Source: review
- Link: docs/x.md
- Author: author:carol
- Confirmed-By: reviewer:alice
- Created: 2026-01-01
- Updated: 2026-02-02
`;
  const entry = parseEntry("/abs/x.md", "decisions/x.md", "decision", md);
  expect(entry.author).toBe("author:carol");
});

test("AFC-25: author, confirmedBy and caveat are null when an entry never captured them", () => {
  const entry = parseEntry(
    "/abs/y.md",
    "decisions/y.md",
    "decision",
    "# Y\n\nVersion: 0.1.0\nType: decision\n\n## Summary\n\nShort summary.\n\n## Provenance\n\n- Source: review\n",
  );
  expect(entry.author).toBeNull();
  expect(entry.confirmedBy).toBeNull();
  expect(entry.caveat).toBeNull();
});

import { test, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { collectEntries, collectEntriesStrict, memoryRoot, parseEntry } from "./store";

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

// Flow 313 (W4) review R1-F3: `parseEntry`'s Source-Harness/Target-Harnesses
// lookup must be scoped to the HEADER BLOCK (before the first `## ` section)
// — never the generic all-lines scan `field()` uses for every other header.
// Discriminating: pre-fix `headerBlockMatches`, a `Source-Harness:` line
// inside `## Summary`/`## Details` was invisible to the scan entirely, so
// the real header-block value ("claude") won cleanly with no trace of the
// body line — this asserts the body line is still never read as if it were
// the header's value (never "first match wins" toward the spoofed id).
//
// R2-F14 (round 2): that same "invisible" pre-fix behaviour is itself the
// bug for a Target-Harnesses restriction — `## Details` here has NO
// well-formed header-block Target-Harnesses at all, only the misplaced
// body line, so pre-fix this entry read as *unrestricted* (visible to every
// harness). Post-fix, a misplaced line anywhere in the body makes that
// header INVALID (hidden from every harness), never silently absent — this
// is a different, stricter outcome than "the body line is ignored", so this
// test's expectations changed from round 1 accordingly.
test("R1-F3/R2-F14: a Source-Harness/Target-Harnesses line inside ## Summary or ## Details is misplaced, not header-block-valid and not silently absent", () => {
  const md = `# Title

Version: 0.1.0
Type: decision
Status: accepted
Source-Harness: claude

## Summary

Source-Harness: codex
An ordinary summary line.

## Details

Target-Harnesses: zed
`;
  const entry = parseEntry("/abs/x.md", "decisions/x.md", "decision", md);
  // The well-formed header-block "claude" never wins once a misplaced
  // duplicate exists in the body: the whole Source-Harness header is
  // invalid, not "first match / header-block match wins".
  expect(entry.sourceHarness).toBeNull();
  expect(entry.sourceHarnessInvalid).toBe(true);
  // No Target-Harnesses line exists in the header block at all — only the
  // misplaced body line — so this must be reported as an invalid,
  // hidden-from-everyone restriction, never as "absent" (unrestricted).
  expect(entry.targetHarnesses ?? null).toBeNull();
  expect(entry.targetHarnessesInvalid).toBe(true);
});

// R1-F14: a duplicate Source-Harness/Target-Harnesses header line WITHIN the
// header block (e.g. a smuggled title line landing above the real, stamped
// one) is ambiguous, not "first match wins" — the entry must read as
// present-but-invalid, never silently resolve to the attacker's value.
test("R1-F3/R1-F14: a duplicate Source-Harness header in the block is invalid, not first-match", () => {
  const md = `# Title
Source-Harness: codex

Version: 0.1.0
Type: decision
Status: accepted
Source-Harness: claude

## Summary

s
`;
  const entry = parseEntry("/abs/y.md", "decisions/y.md", "decision", md);
  expect(entry.sourceHarness).toBeNull();
  expect(entry.sourceHarnessInvalid).toBe(true);
});

// R1-F14: a malformed Target-Harnesses value (an unknown id in the list, or
// bad capitalization) must not collapse to "unrestricted" — the pre-fix
// behaviour was exactly this: `parseHarnessList` returning null made
// `targetHarnesses` indistinguishable from "the header was never written",
// so the entry became visible/handoff-eligible to every harness.
test("R1-F14: a malformed Target-Harnesses value is flagged invalid, not treated as absent", () => {
  const md = `# Title

Version: 0.1.0
Type: decision
Status: accepted
Source-Harness: claude
Target-Harnesses: codex, Claude

## Summary

s
`;
  const entry = parseEntry("/abs/z.md", "decisions/z.md", "decision", md);
  expect(entry.targetHarnesses ?? null).toBeNull();
  expect(entry.targetHarnessesInvalid).toBe(true);
});

// Flow 313 (W4) review R2-F5: JS regex "." and "$" (without "m") both treat
// "\r" as a line terminator "." never matches and "$" can't reach past — so
// a CRLF (or lone-CR) file used to fail EVERY per-line header/field pattern
// in this module, not merely mis-parse them. Discriminating: on pre-fix code
// (content.split("\n") only, no normalisation) `Status:` and
// `Target-Harnesses:` both fail to match a line ending in "\r", so
// `entry.status` falls back to "draft" and `entry.targetHarnesses` reads as
// null (unrestricted) instead of the real restriction — this asserts
// neither happens.
test("R2-F5: a CRLF-authored entry parses Status and Target-Harnesses instead of losing them", () => {
  const lines = [
    "# Title",
    "",
    "Version: 0.1.0",
    "Type: decision",
    "Status: accepted",
    "Source-Harness: claude",
    "Target-Harnesses: codex",
    "",
    "## Summary",
    "",
    "A summary.",
    "",
  ];
  const crlf = lines.join("\r\n");
  const entry = parseEntry("/abs/crlf.md", "decisions/crlf.md", "decision", crlf);
  expect(entry.status).toBe("accepted");
  expect(entry.sourceHarness).toBe("claude");
  expect(entry.targetHarnesses).toEqual(["codex"]);
  expect(entry.targetHarnessesInvalid).toBe(false);
});

// Same discriminating shape as above, but with a lone CR (old Mac-style)
// line ending instead of CRLF — `\r` alone also breaks "." / "$" the same
// way, independent of whether it is paired with a following "\n".
test("R2-F5: a lone-CR-authored entry parses Status and Target-Harnesses instead of losing them", () => {
  const lines = [
    "# Title",
    "",
    "Version: 0.1.0",
    "Type: decision",
    "Status: accepted",
    "Target-Harnesses: codex",
    "",
    "## Summary",
    "",
    "A summary.",
    "",
  ];
  const cr = lines.join("\r");
  const entry = parseEntry("/abs/cr.md", "decisions/cr.md", "decision", cr);
  expect(entry.status).toBe("accepted");
  expect(entry.targetHarnesses).toEqual(["codex"]);
  expect(entry.targetHarnessesInvalid).toBe(false);
});

// Flow 313 (W4) review R3-F7 (re-listed under R2-F5), choke point d: the
// shared `splitLogicalLines` handles U+2028/U+2029/U+0085 the same way it
// already handles CRLF/CR — a `Target-Harnesses:` header separated from the
// rest of the header block by one of these codepoints must not read as
// absent. Discriminating: pre-fix `normalizeLineEndings` only replaced
// `\r\n`/`\r`; `content.split("\n")` never split on U+2028/U+2029/U+0085 at
// all, so the WHOLE file (title through Provenance) was one "line" and every
// per-line pattern failed to match, exactly like the CRLF regression above.
for (const [label, sep] of [
  ["U+2028 LINE SEPARATOR", "\u2028"],
  ["U+2029 PARAGRAPH SEPARATOR", "\u2029"],
  ["U+0085 NEXT LINE", "\u0085"],
] as const) {
  test(`R2-F5/R3-F7: an entry separated by ${label} parses Status and Target-Harnesses instead of losing them`, () => {
    const lines = [
      "# Title",
      "",
      "Version: 0.1.0",
      "Type: decision",
      "Status: accepted",
      "Source-Harness: claude",
      "Target-Harnesses: codex",
      "",
      "## Summary",
      "",
      "A summary.",
      "",
    ];
    const content = lines.join(sep);
    const entry = parseEntry("/abs/sep.md", "decisions/sep.md", "decision", content);
    expect(entry.status).toBe("accepted");
    expect(entry.sourceHarness).toBe("claude");
    expect(entry.targetHarnesses).toEqual(["codex"]);
    expect(entry.targetHarnessesInvalid).toBe(false);
  });
}

// Flow 313 (W4) review R3-F7: a header KEY that nearly matches
// `Source-Harness`/`Target-Harnesses` (case variant, missing/extra hyphen,
// underscore, extra whitespace, a fullwidth colon, an embedded zero-width
// space, a Unicode hyphen, or the named singular/plural slip) must be
// treated as an ATTEMPTED but invalid header — hiding the entry from every
// harness — never as "absent" (which would leave the entry visible to
// every harness, silently dropping the intended restriction).
const NEAR_MISS_TARGET_LINES: Array<[string, string]> = [
  ["space-key", "Target Harnesses: codex"],
  ["underscore-key", "Target_Harnesses: codex"],
  ["singular-key", "Target-Harness: codex"],
  ["fullwidth-colon", "Target-Harnesses\uff1a codex"],
  ["zwsp-key", "Target-Har\u200bnesses: codex"],
  ["u2010-hyphen-key", "Target\u2010Harnesses: codex"],
];

for (const [label, headerLine] of NEAR_MISS_TARGET_LINES) {
  test(`R3-F7: a near-miss Target-Harnesses key (${label}) is invalid, not absent`, () => {
    const md = [
      "# Title",
      "",
      "Version: 0.1.0",
      "Type: decision",
      "Status: accepted",
      headerLine,
      "",
      "## Summary",
      "",
      "s",
      "",
    ].join("\n");
    const entry = parseEntry("/abs/near.md", "decisions/near.md", "decision", md);
    expect(entry.targetHarnesses ?? null).toBeNull();
    expect(entry.targetHarnessesInvalid).toBe(true);
  });
}

test("R3-F7: an unrelated 'Name:' line near the header block is never mistaken for a near-miss header", () => {
  const md = [
    "# Title",
    "",
    "Version: 0.1.0",
    "Type: decision",
    "Status: accepted",
    "",
    "## Summary",
    "",
    "s",
    "",
    "## Provenance",
    "",
    "- Source: review",
    "- Target: nowhere",
    "",
  ].join("\n");
  const entry = parseEntry("/abs/unrelated.md", "decisions/unrelated.md", "decision", md);
  expect(entry.targetHarnesses ?? null).toBeNull();
  expect(entry.targetHarnessesInvalid).toBe(false);
});

// Flow 313 (W4) review R3-F3: `keryx init`'s own memory scaffold
// (`index.md`, `templates/entry.md`) must never make `collectEntriesStrict`
// report `incomplete` — that made `memory handoff` permanently unable to
// report `complete` in ANY initialized project, including this repo.
test("R3-F3: collectEntriesStrict recognises the keryx init memory scaffold and stays complete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keryx-store-scaffold-"));
  try {
    await mkdir(path.join(root, "lessons"), { recursive: true });
    await writeFile(
      path.join(root, "lessons", "ok.md"),
      "# Ok\n\nVersion: 0.1.0\nType: lesson\nStatus: accepted\n\n## Summary\n\nFine.\n",
    );
    await writeFile(path.join(root, "index.md"), "# Project Memory\n\nScaffold.\n");
    await mkdir(path.join(root, "templates"), { recursive: true });
    await writeFile(path.join(root, "templates", "entry.md"), "# <Title>\n\nScaffold template.\n");

    const result = await collectEntriesStrict(root);
    expect(result.status).toBe("complete");
    expect(result.problems).toEqual([]);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["lessons/ok.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R3-F3: a genuinely unexpected top-level markdown file is still reported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keryx-store-unexpected-"));
  try {
    await writeFile(path.join(root, "misc.md"), "# Misc\n\nNot a scaffold file.\n");
    const result = await collectEntriesStrict(root);
    expect(result.status).toBe("incomplete");
    expect(result.problems).toEqual([{ path: "misc.md", reason: "unexpected-entry" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 313 (W4) review R3-F9/R3-F10: the LENIENT scan (`collectEntries`) is
// what feeds `memory.search`, `wiki.ask` and the MCP resources list —
// exactly the callers that must never hang on a FIFO or serve content from
// outside the memory root via a symlink. This mirrors the strict scan's
// existing symlink/non-regular refusal, applied to the lenient path.
test("R3-F9/R3-F10: collectEntries skips a symlinked *.md file instead of following it outside the root", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keryx-store-lenient-symlink-"));
  try {
    const root = memoryRoot(cwd);
    await mkdir(path.join(root, "lessons"), { recursive: true });
    await writeFile(
      path.join(root, "lessons", "ok.md"),
      "# Ok\n\nVersion: 0.1.0\nType: lesson\nStatus: accepted\n\n## Summary\n\nFine.\n",
    );
    const outside = path.join(cwd, "outside.md");
    await writeFile(outside, "# Outside\n\nVersion: 0.1.0\nType: lesson\nStatus: accepted\n\n## Summary\n\nSECRET.\n");
    await symlink(await realpath(outside), path.join(root, "lessons", "link.md"));

    const entries = await collectEntries(cwd);
    expect(entries.map((entry) => entry.relativePath)).toEqual(["lessons/ok.md"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("R3-F9: collectEntries skips a directory named *.md instead of throwing EISDIR", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keryx-store-lenient-dir-"));
  try {
    const root = memoryRoot(cwd);
    await mkdir(path.join(root, "lessons", "folder.md"), { recursive: true });
    await writeFile(
      path.join(root, "lessons", "ok.md"),
      "# Ok\n\nVersion: 0.1.0\nType: lesson\nStatus: accepted\n\n## Summary\n\nFine.\n",
    );

    const entries = await collectEntries(cwd);
    expect(entries.map((entry) => entry.relativePath)).toEqual(["lessons/ok.md"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("R3-F9: collectEntries skips a FIFO named *.md instead of hanging on readFile", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "keryx-store-lenient-fifo-"));
  try {
    const root = memoryRoot(cwd);
    await mkdir(path.join(root, "lessons"), { recursive: true });
    await writeFile(
      path.join(root, "lessons", "ok.md"),
      "# Ok\n\nVersion: 0.1.0\nType: lesson\nStatus: accepted\n\n## Summary\n\nFine.\n",
    );
    const fifoPath = path.join(root, "lessons", "pipe.md");
    execSync(`mkfifo ${JSON.stringify(fifoPath)}`);

    const entries = await collectEntries(cwd);
    expect(entries.map((entry) => entry.relativePath)).toEqual(["lessons/ok.md"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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

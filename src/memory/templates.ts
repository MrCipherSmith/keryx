import { splitLogicalLines } from "../lib/text-lines";
import { extractHeaderKey, isHarnessHeaderKey } from "./store";
import { MEMORY_TYPES } from "./types";

// Flow 313 (W4) review R1-F3: the LAST line of defense against a
// `Source-Harness:`/`Target-Harnesses:` header smuggled through free text —
// applied here rather than only at the MCP tool boundary (`src/mcp/tools.ts`)
// so a caller that bypasses that boundary entirely (the CLI's `keryx memory
// new --title`, or any future caller of this function) gets the same
// guarantee. `title` is a SINGLE-LINE field rendered as `# ${title}` on the
// file's first line: any control character or line-terminator codepoint in
// it — not only `\n` — is refused outright, which also makes the header-line
// guard below unreachable for `title` (kept anyway as defense-in-depth in
// case that refusal is ever loosened). `summary`/`details` are legitimately
// multi-line, so they are checked line-by-line instead.
//
// Built with `new RegExp` from escape sequences rather than a `/.../` literal
// containing the raw codepoints: a literal U+2028/U+2029 inside a regex
// literal is itself treated as a line terminator by some source tooling,
// which is exactly the ambiguity this guard exists to close — the pattern
// must not itself depend on a tool treating those bytes as ordinary text.
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this guard.
const CONTROL_OR_LINE_BREAK_RE = new RegExp("[\\u0000-\\u001F\\u007F\\u2028\\u2029]");
// Flow 313 (W4) review R3-F8, choke point d: exported (and re-exported
// through `./service.ts`, the ONLY module `src/mcp/` may import — M-3) so
// the MCP `memory.propose` boundary's early pre-check uses this SAME
// function instead of a second, independently-drifting copy of the pattern
// and the line-split rule. `renderMemoryEntry` below remains the real,
// authoritative guard for every caller; the MCP boundary's use of this
// export is only a friendlier, fail-fast duplicate of the same check.
//
// Round-4 review: this used to be its own regex (`HARNESS_HEADER_LINE_RE`),
// independent of `./store.ts`'s parser-side near-miss fold — the two could
// and did drift (`p7b`: a singular `Target-Harness:`, a `Target‐Harnesses`
// with a U+2010 hyphen, a zero-width-space key, and other near misses all
// passed this guard, then the parser read them as present-but-invalid and
// hid the entry from every harness, wedging `memory handoff` incomplete
// until a human deleted the proposal). It now extracts the candidate KEY
// with the SAME `extractHeaderKey` and folds it with the SAME
// `isHarnessHeaderKey` the parser's `locateHeaderField` uses — one shared
// near-miss header key matcher for both call sites, so a spelling the
// parser would flag as present-but-invalid is refused HERE too, before it
// is ever written.
export function containsHarnessHeaderLine(value: string): boolean {
  return splitLogicalLines(value).some((line) => {
    const key = extractHeaderKey(line);
    return key !== null && isHarnessHeaderKey(key);
  });
}

export function renderMemoryEntry({
  title,
  type,
  date,
  confidence = "medium",
  source = "manual",
  summary,
  details,
  sourceHarness,
  targetHarnesses,
}: {
  title: string;
  type: string;
  date: string;
  confidence?: string;
  source?: string;
  // Flow 313 (W4): optional overrides for the MCP `memory.propose` tool
  // (and any future caller that needs real content, not the scaffold
  // placeholders below). Absent -> the pre-existing scaffold text, so every
  // existing caller of this function is byte-identical.
  summary?: string;
  details?: string;
  sourceHarness?: string;
  targetHarnesses?: string[];
}): string {
  // Flow 313 (W4) review R1-F3: refused HERE, not only at the MCP tool
  // boundary, so every caller — MCP `memory.propose` and the CLI's `keryx
  // memory new --title` alike — gets the same guarantee that a rendered
  // entry's header block can never carry an attacker-controlled
  // `Source-Harness:`/`Target-Harnesses:` line.
  if (CONTROL_OR_LINE_BREAK_RE.test(title)) {
    throw new Error(
      "memory entry title may not contain control characters or line separators (CR, LF, U+2028, U+2029).",
    );
  }
  if (containsHarnessHeaderLine(title)) {
    // Unreachable given the control-character refusal above (a title with no
    // line break at all cannot itself be a multi-line header-line match) —
    // kept as defense-in-depth in case that refusal is ever loosened.
    throw new Error("memory entry title may not contain a Source-Harness:/Target-Harnesses: line.");
  }
  if (summary !== undefined && containsHarnessHeaderLine(summary)) {
    throw new Error("memory entry summary may not contain a Source-Harness:/Target-Harnesses: line.");
  }
  if (details !== undefined && containsHarnessHeaderLine(details)) {
    throw new Error("memory entry details may not contain a Source-Harness:/Target-Harnesses: line.");
  }

  const harnessHeaderLines = [
    ...(sourceHarness ? [`Source-Harness: ${sourceHarness}`] : []),
    ...(targetHarnesses && targetHarnesses.length > 0 ? [`Target-Harnesses: ${targetHarnesses.join(", ")}`] : []),
  ];
  const harnessHeader = harnessHeaderLines.length > 0 ? `${harnessHeaderLines.join("\n")}\n` : "";
  return `# ${title}

Version: 0.2.0
Type: ${type}
Status: draft
Confidence: ${confidence}
Caveat:
${harnessHeader}
## Summary

${summary ?? "Short summary."}

## Details

${details ?? "Main memory content."}

## Provenance

- Source: ${source}
- Link:
- Author:
- Confirmed-By:
- Created: ${date}
- Updated: ${date}

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

## Changelog

- 0.1.0 - Initial version.
`;
}

export function renderMemoryEntryTemplate(): string {
  return `# <Title>

Version: 0.1.0
Type: <lesson|decision|constraint|known-mistake|...>
Status: draft
Confidence: medium
Caveat: <optional deferral/qualification attached to this claim>

## Summary

Short summary.

## Details

Main memory content.

## Provenance

- Source: review|health|orchestrator|manual|skill-verifier
- Link: <path or URL>
- Author: <optional author/proposer>
- Confirmed-By: <optional confirming participant>
- Created: YYYY-MM-DD
- Updated: YYYY-MM-DD

## Related Scopes

- Module: <module>
- Entity: <entity>
- Files:
  - \`src/...\`
- Skills:
  - \`.metaproject/skills/...\`

## Tags

- <tag>

## Changelog

- 0.1.0 - Initial version.
`;
}

export function renderMemoryIndexScaffold(): string {
  const typeList = MEMORY_TYPES.map(
    (entry) => `- \`${entry.type}\` (\`${entry.folder}/\`)`,
  ).join("\n");

  return `# Project Memory

Version: 0.2.0

## Purpose

Long-term project memory: lessons learned, decisions, constraints, known
mistakes, historical context, and reusable patterns. Markdown is the source of
truth; \`keryx memory index\` optionally builds a disposable generated catalog
for inspection. Search scans canonical Markdown directly and does not depend on
the catalog.

## Entry Types

${typeList}

## Usage

\`\`\`bash
keryx memory new lesson --title "<title>"
keryx memory index [--embeddings]
keryx memory search "<query>" --status accepted [--save-report]
keryx memory transition <path> --to accepted --reason "<reason>"
\`\`\`

Default search is pure and never writes a report. Only \`accepted\`, current,
scoped, bounded projections influence skills; \`draft\` entries are advisory.
`;
}

export function renderMemoryManifest(): string {
  return `# memory

Version: 0.2.0

## Purpose

Long-term, typed project memory with deterministic ranked search and a
gdskills learning signal.

## Commands

- \`keryx memory new <type> --title "<title>"\`
- \`keryx memory index [--embeddings]\` (optional disposable catalog/cache)
- \`keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <class>] [--semantic] [--save-report]\` (pure by default)
- \`keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]\`
- \`keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]\`
- \`keryx memory ingest --from-<source> <path>\`
- \`keryx memory check\`

## Config

- \`memory.config.json\`

## Data

- \`memory/index.md\`
- \`data/memory/index/index.json\` (disposable generated catalog)
- \`data/memory/embeddings/\` (disposable optional cache)
- \`runtime/memory/search/<run-id>/\` (explicit reports only)

Search reads canonical Markdown directly and never consumes the generated
catalog or writes a legacy global \`latest\` report. Downstream migration from
legacy \`data/memory/artifacts/latest.*\` is advisory and never deletes files or
changes the Git index automatically.

## Skills

- \`skills/memory/\`
`;
}

export function renderMemoryCoreReadme(): string {
  return `# memory Core

Local Documentation Memory service layer.

Responsibilities:

- read typed Markdown entries under \`.metaproject/memory\` (source of truth);
- optionally build a deterministic disposable catalog under
  \`.metaproject/data/memory/index\` (search does not consume it);
- rank search by relevance + recency + confidence + status + scope;
- ingest source artifacts as \`draft\` entries with provenance;
- run deterministic dedup/conflict checks.

Only \`accepted\` entries influence skills. Findings are a decoupled, versioned
contract consumed by gdskills via \`keryx skills learn --from-memory\`.
`;
}

export function renderMemorySkillReadme(): string {
  return `---
name: memory
description: Use for durable project knowledge - past decisions, constraints, known mistakes, lessons, and patterns. Search memory before planning or implementing to avoid repeating mistakes; propose durable entries after tasks.
---

# memory Skill

Use this skill for long-term project experience: accepted decisions,
constraints, known mistakes, lessons, and reusable patterns.

## Workflow

1. Before planning/implementing, run \`keryx memory search "<topic>" --status accepted\`.
2. Read only the returned snippets, not the whole memory.
3. Respect accepted decisions/constraints; treat \`draft\`/\`conflict\` as advisory.
4. After a task/review, propose durable entries with \`keryx memory new\` or \`ingest\`.
5. Run \`keryx memory check\` before relying on cross-entry links.

## Commands

\`\`\`bash
keryx memory search "<query>" --status accepted
keryx memory new lesson --title "<title>"
keryx memory ingest --from-review <path>
keryx memory check
\`\`\`

## Notes

- Only \`accepted\` entries influence skills; \`draft\` are advisory.
- Markdown is the source of truth; generated catalogs, embeddings, and reports
  are disposable and ignored. Default recall does not persist a report.
- Existing legacy \`data/memory/artifacts/latest.*\` files are never deleted or
  changed automatically; init/update report an advisory migration instead.
`;
}

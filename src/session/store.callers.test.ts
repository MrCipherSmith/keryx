// Every caller of a transcript reader that THROWS must guard the throw.
//
// Flow 130 gave the session readers a typed refusal — an oversized or
// non-regular transcript raises `TranscriptUnreadableError` instead of reading
// back as an empty conversation. That is the right contract and it moved the
// risk: a reader that used to return `[]` now throws, and a caller written
// against the old behaviour crashes or silently drops the session.
//
// The consolidated review of PR #219 found two such callers by reading eleven
// call sites by hand (`sessions.ts` and the TUI's `/resume` handler). This is
// the half that makes the twelfth impossible: the denominator is derived from
// the source rather than written down, so a new caller is an offence until
// someone guards it or excuses it with a reason.
//
// Built from the `config-dir.readers.test.ts` template, deliberately, and NOT
// from the two decorative guards the same review found on the sibling branch:
// the self-check below drives `unguardedCalls()` itself, the scan-reach
// assertion is separate from the offence assertion, and the numerator has its
// own control.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { code, sourceFiles, treeSources } from "../lib/config-dir.scan";

const SRC = path.join(import.meta.dir, "..");

/**
 * The readers that can raise `TranscriptUnreadableError`.
 *
 * `openSession` and `exportSessionMarkdown` are here because they call the
 * other two — a caller does not care which frame threw.
 */
const THROWING_READERS = [
  "openSession(",
  "loadContext(",
  "loadArchive(",
  "loadTranscript(",
  "exportSessionMarkdown(",
] as const;

interface UnguardedCall {
  file: string;
  call: string;
}

interface CallerExemption {
  file: string;
  reason: string;
}

/**
 * Files excused from the rule, each with the reason.
 *
 * A bare path is not accepted: an exemption without a reason is
 * indistinguishable from an oversight, and an oversight is what this guard
 * exists to prevent.
 */
const CALLER_EXEMPTIONS: ReadonlyArray<CallerExemption> = [
  {
    file: "session/store.ts",
    reason:
      "declares the readers and raises the error; its own internal calls are the fallback chain (loadArchive -> loadContext), where catching would re-create the silent-empty this module throws to prevent",
  },
];

/** The regions of `source` enclosed by a `try { … }` block, as index ranges. */
function tryRegions(source: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const opener = /\btry\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
      const char = source[i];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          regions.push([match.index, i]);
          break;
        }
      }
    }
  }
  return regions;
}

/**
 * Calls to a throwing reader that are not inside a `try`.
 *
 * PURE over a `{ path -> source }` map, for the reason the writers guard
 * records: a self-check that re-implements the predicate instead of calling it
 * stays green when the predicate is replaced by `return []`.
 *
 * LIMIT, stated rather than discovered later: this is lexical. A caller that
 * wraps its call in a helper, and guards the helper, reads as unguarded here
 * and needs an exemption; a caller with a `try` whose `catch` swallows
 * everything reads as guarded. The behavioural probes in
 * `lib/config-dir.readers.test.ts` are what prove the guards actually do
 * something — this one proves nobody forgot to write one.
 */
export function unguardedCalls(sources: ReadonlyMap<string, string>): UnguardedCall[] {
  const excused = new Set(CALLER_EXEMPTIONS.map((exemption) => exemption.file));
  const found: UnguardedCall[] = [];
  for (const [relative, raw] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (excused.has(relative)) {
      continue;
    }
    const source = code(raw);
    const regions = tryRegions(source);
    for (const call of THROWING_READERS) {
      for (let at = source.indexOf(call); at !== -1; at = source.indexOf(call, at + 1)) {
        // A declaration or a re-export is not a call site.
        if (/[\w.]/.test(source[at - 1] ?? "")) {
          continue;
        }
        if (regions.some(([open, close]) => at > open && at < close)) {
          continue;
        }
        found.push({ file: relative, call });
        break;
      }
    }
  }
  return found;
}

describe("every caller of a throwing transcript reader guards the throw", () => {
  test("no un-exempt file calls one outside a try", () => {
    expect(unguardedCalls(treeSources(SRC))).toEqual([]);
  });

  test("the scan actually reaches the source tree", () => {
    // Without this the assertion above passes vacuously if the root moves.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("session/store.ts");
    expect(files).toContain("commands/sessions.ts");
    expect(files).toContain("tui/tui-shell.ts");
  });

  test("the scan finds files that genuinely call a throwing reader", () => {
    // The complement being empty means nothing if the numerator is empty too.
    const callers = sourceFiles(SRC).filter((relative) => {
      const source = code(treeSources(SRC).get(relative) ?? "");
      return THROWING_READERS.some((call) => source.includes(call));
    });
    expect(callers.length).toBeGreaterThanOrEqual(3);
    expect(callers).toContain("commands/shell.ts");
    expect(callers).toContain("commands/sessions.ts");
    expect(callers).toContain("tui/tui-shell.ts");
  });

  test("every exemption names a file that exists and states a reason", () => {
    const files = new Set(sourceFiles(SRC));
    for (const exemption of CALLER_EXEMPTIONS) {
      expect({ file: exemption.file, present: files.has(exemption.file) }).toEqual({
        file: exemption.file,
        present: true,
      });
      expect(exemption.reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("the detector reports an unguarded call, through unguardedCalls() itself", () => {
    // Through the seam, not through a re-implementation of the predicate.
    const shapes: ReadonlyArray<{ label: string; source: string }> = [
      { label: "a bare call", source: "const s = openSession({ cwd });" },
      {
        label: "a call after an unrelated try block has closed",
        source: "try { setup(); } catch { ignore(); }\nconst s = openSession({ cwd });",
      },
      {
        label: "a call inside a function declared inside a try",
        source: "const later = () => exportSessionMarkdown(cwd, id);\ntry { later(); } catch { report(); }",
      },
      { label: "a nested reader", source: "console.log(loadArchive(cwd, id));" },
      // The two the review found by hand, as they were written. If the
      // predicate ever stops reporting these, it has stopped being the guard
      // that would have caught them.
      {
        label: "commands/sessions.ts as it was",
        source: "console.log(exportSessionMarkdown(cwd, found.id));",
      },
      {
        label: "tui/tui-shell.ts /resume as it was",
        source:
          "applyOpened(\n  openSession({\n    cwd: sessionCwd,\n    resumeId: found.id,\n  }),\n);\npaintSessionHeader();",
      },
    ];

    const missed = shapes
      .filter((shape) => unguardedCalls(new Map([[`probe/${shape.label}.ts`, shape.source]])).length === 0)
      .map((shape) => shape.label);

    expect(missed).toEqual([]);
  });

  test("the detector does NOT report a guarded call", () => {
    // The other half. Without it the assertion above is satisfied by a detector
    // that reports everything, which would be just as useless.
    const clean = new Map([
      ["probe/guarded.ts", "try {\n  const s = openSession({ cwd });\n} catch (e) {\n  report(e);\n}"],
      [
        "probe/nested-braces.ts",
        "try {\n  if (x) {\n    const s = loadContext(cwd, id);\n  }\n} catch (e) {\n  report(e);\n}",
      ],
      ["probe/unrelated.ts", "const s = loadSomethingElse(cwd);"],
      ["probe/mentions-in-a-comment.ts", "// openSession( is named here and never called"],
      ["probe/re-export.ts", "export { openSession } from './store';"],
    ]);
    expect(unguardedCalls(clean)).toEqual([]);
  });
});

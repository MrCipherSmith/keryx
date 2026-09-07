// AFC-06 (flow 234) AC1 — "Дата границы, future, deprecated, conflict,
// superseded и malformed имеют одинаковый допуск в wiki/memory". This is the
// test that actually proves AC1, distinct from `../memory/lifecycle.test.ts`
// (which only proves the shared `computeLifecycle` formula is internally
// correct) and `./provenance.test.ts` (which only proves the wiki-side
// wrapper delegates to it). Neither of those exercises two DIFFERENT live
// retrieval surfaces side by side and checks they agree.
//
// Here the same seven input classes are driven through:
//   - the memory retrieval path: real `.md` fixtures -> `collectEntries` ->
//     `searchEntries` (`../memory/search.ts`, T14 defect 2's fix), the
//     actual function `memory search` and `wikiAsk`'s memory candidates run
//     live queries through.
//   - the wiki retrieval path: real `.md` fixtures -> `wikiAsk` (`./ask.ts`)
//     -> its wiki-candidate filter (T18 item 1's fix), the actual function
//     `gdwiki ask` runs live queries through. This used to go through
//     `parsePageLifecycle` (`./provenance.ts`) directly — a parser, not the
//     retrieval path — which proved the classifier agreed with memory's but
//     said nothing about whether a live `wikiAsk` query would actually admit
//     or reject the page; `provenance.test.ts` already covers the parser in
//     isolation, so this file exists specifically to close that gap.
// Both retrieval paths ultimately call the same `computeLifecycle` (`../
// memory/lifecycle.ts`), so agreement here is direct evidence for AC1, not
// an inference from reading the source.
//
// Class boundary dates are computed relative to the real wall-clock date
// rather than hardcoded, because this test calls `wikiAsk` with no `asOf`
// (T22, flow 234, added `WikiAskInput.asOf` as an explicit historical-mode
// observedAt override; default-mode calls like this one still classify
// against `new Date()` at call time exactly as before T22). Using the same
// real "today" to build both the memory-side `NOW` and the wiki fixtures'
// dates keeps the two sides comparing the same calendar day.
//
// Class 5 (conflicted/cyclic supersession) is asserted at the admit/reject
// level only: neither production retrieval path threads a
// `SupersessionLookup` today (search.ts's `temporalMatch` and wiki/ask.ts's
// memory- AND wiki-candidate filters all call `computeLifecycle` with no
// third argument), so a cyclic chain resolves to the presence-only
// "superseded" branch on both sides rather than to `computeLifecycle`'s
// lookup-aware "conflict" state. `../memory/lifecycle.test.ts` already
// covers the conflict-vs-superseded distinction directly; what matters for
// AC1 is that both retrieval surfaces reject the entry identically, which
// they do. This is an honest limitation, not something this task closes.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MEMORY_CONFIG } from "../memory/config";
import { searchEntries } from "../memory/search";
import { collectEntries } from "../memory/store";
import { wikiAsk } from "./ask";

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date(`${TODAY}T00:00:00.000Z`);
const TAG = "lifecycle parity fixture entry";

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Comfortably past/future of "today" regardless of when the suite runs.
const PAST = addDays(TODAY, -180);
const FUTURE = addDays(TODAY, 3650);

type Class = {
  name: string;
  memoryFields: Record<string, string>;
  wikiFields: Record<string, string>;
  expectCurrent: boolean;
};

// Same seven input classes (AC1), expressed once and rendered into both a
// memory frontmatter shape (`Valid-From`/`Valid-To`/`Superseded-By`, the
// shape `src/memory/store.ts` parses) and a wiki frontmatter shape
// (`ValidFrom`/`ValidTo`/`SupersededBy`, the shape `src/wiki/collect.ts` and
// `parsePageLifecycle` document as canonical) so the two surfaces see the
// identical event-time/status facts.
const CLASSES: Class[] = [
  {
    name: "date boundary: validFrom == observedAt is current",
    memoryFields: { Status: "accepted", "Valid-From": TODAY },
    wikiFields: { Status: "accepted", ValidFrom: TODAY },
    expectCurrent: true,
  },
  {
    name: "date boundary: validTo == observedAt is not current (exclusive upper bound)",
    memoryFields: { Status: "accepted", "Valid-From": PAST, "Valid-To": TODAY },
    wikiFields: { Status: "accepted", ValidFrom: PAST, ValidTo: TODAY },
    expectCurrent: false,
  },
  {
    name: "future: validFrom later than observedAt is not current",
    memoryFields: { Status: "accepted", "Valid-From": FUTURE },
    wikiFields: { Status: "accepted", ValidFrom: FUTURE },
    expectCurrent: false,
  },
  {
    name: "deprecated: never current regardless of dates",
    memoryFields: { Status: "deprecated" },
    wikiFields: { Status: "deprecated" },
    expectCurrent: false,
  },
  {
    name: "conflicted/cyclic supersession chain: rejected on both surfaces",
    memoryFields: { Status: "accepted", "Superseded-By": "decisions/cycle-a.md" },
    wikiFields: { Status: "accepted", SupersededBy: "decisions/cycle-a.md" },
    expectCurrent: false,
  },
  {
    name: "plain superseded: an accepted entry with a supersededBy pointer is not current",
    memoryFields: { Status: "accepted", "Superseded-By": "decisions/replacement.md" },
    wikiFields: { Status: "accepted", SupersededBy: "decisions/replacement.md" },
    expectCurrent: false,
  },
  {
    name: "malformed date: an unparsable validFrom is rejected, never silently current",
    memoryFields: { Status: "accepted", "Valid-From": "not-a-date" },
    wikiFields: { Status: "accepted", ValidFrom: "not-a-date" },
    expectCurrent: false,
  },
];

function renderMemoryEntry(title: string, fields: Record<string, string>): string {
  const lines = [`# ${title}`, "Type: decision", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)];
  lines.push("", "## Summary", "", TAG, "");
  return lines.join("\n");
}

function renderWikiPage(title: string, fields: Record<string, string>): string {
  const lines = [`# ${title}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)];
  lines.push("", "## Summary", "", TAG, "");
  return lines.join("\n");
}

describe("AC1 parity: wiki and memory admit/reject the same seven input classes identically", () => {
  test.each(CLASSES.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, klass) => {
      const root = await mkdtemp(path.join(tmpdir(), "gd-lifecycle-parity-"));
      try {
        // --- memory retrieval path (T14 defect 2): the actual function
        // `memory search`/`wikiAsk`'s memory candidates run live queries
        // through, called directly with an explicit `now` so the class table
        // stays deterministic regardless of the memory-side comment above
        // about `wikiAsk` having no such override.
        await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
        await writeFile(
          path.join(root, ".metaproject", "memory", "decisions", "subject.md"),
          renderMemoryEntry("Subject entry", klass.memoryFields),
          "utf8",
        );
        const entries = await collectEntries(root);
        const results = searchEntries(entries, TAG, {}, DEFAULT_MEMORY_CONFIG, NOW);
        const memoryCurrent = results.some((r) => r.entry.relativePath === "decisions/subject.md");

        // --- wiki retrieval path (T18 item 1): the actual candidate
        // selection `wikiAsk` (`./ask.ts`) runs, not `parsePageLifecycle`
        // called directly.
        await mkdir(path.join(root, ".metaproject", "wiki", "decisions"), { recursive: true });
        await writeFile(
          path.join(root, ".metaproject", "wiki", "decisions", "subject.md"),
          renderWikiPage("Subject page", klass.wikiFields),
          "utf8",
        );
        const askResult = await wikiAsk({ cwd: root, question: TAG });
        const wikiCurrent = askResult.citations.some((c) => c.path === "wiki/decisions/subject.md");

        expect(memoryCurrent).toBe(klass.expectCurrent);
        expect(wikiCurrent).toBe(klass.expectCurrent);
        expect(memoryCurrent).toBe(wikiCurrent);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

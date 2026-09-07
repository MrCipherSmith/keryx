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

// T24 (flow 234) F-004 (MAJOR): AC1's SECOND half -- "historical режим явно
// размечен" -- is not just about labelling; the reviewer's finding is that
// `--as-of` SCOPED INCLUSION on `memory search` (`searchEntries`'s `asOf`
// branch, `../memory/search.ts`) while `wiki ask --as-of` only used the date
// to LABEL a citation, admitting every non-current item unconditionally the
// instant historical mode was on. Because `wikiAsk`'s memory candidates read
// the exact same `.md` files `memory search` does, this meant the SAME
// memory entry file got one verdict from `keryx memory search --as-of` and a
// different one from `keryx wiki ask --as-of` -- not merely two independent
// surfaces disagreeing, but one retrieval path silently overriding the
// other's answer about the identical fact.
//
// Six classes per AC1 (`Дата границы, future, deprecated, conflict,
// superseded и malformed`), each driven at ONE fixed `ASOF` query date
// through THREE verdicts on facts written once:
//   - `memoryAdmitted`   -- `searchEntries` with `{ asOf: ASOF }`, the exact
//     function `keryx memory search --as-of` runs (mirrors the describe
//     block above's `memoryCurrent`, but historical-mode).
//   - `wikiAskMemoryAdmitted` -- `wikiAsk({ asOf: ASOF })`'s citation for
//     `memory/decisions/subject.md` -- the SAME memory `.md` file, read
//     through `wikiAsk`'s OWN memory-candidate pass rather than
//     `searchEntries`. This is the assertion that catches F-004 directly:
//     before the fix this was `true` for every non-current class regardless
//     of `memoryAdmitted`.
//   - `wikiAskWikiAdmitted` -- `wikiAsk({ asOf: ASOF })`'s citation for the
//     wiki-authored `wiki/decisions/subject.md` fixture, proving the fix
//     also applies to genuine wiki pages, not only to the memory candidates
//     `wikiAsk` happens to also search.
// Class 5 (conflict-shaped) is asserted at the admit/reject level only, for
// the same reason the default-mode table above is: neither retrieval path
// threads a `SupersessionLookup`, so an unresolved/cyclic `supersededBy`
// pointer resolves through the same presence-only branch as a plain
// superseded pointer (`computeLifecycle`, `../memory/lifecycle.ts`).
describe("AC1 second half: --as-of SCOPES inclusion identically on memory search and wiki ask (historical mode, six classes)", () => {
  const ASOF = TODAY;
  const OLD_START = addDays(TODAY, -400);
  const FAR_FUTURE = addDays(TODAY, 3650);

  type HistoricalClass = {
    name: string;
    memoryFields: Record<string, string>;
    wikiFields: Record<string, string>;
    // Whether BOTH `memory search --as-of ASOF` and `wiki ask --as-of ASOF`
    // should admit this fact -- the identical verdict AC1 requires.
    expectAdmit: boolean;
  };

  const HISTORICAL_CLASSES: HistoricalClass[] = [
    {
      name: "date boundary / valid-then: interval containing ASOF is admitted on both surfaces",
      memoryFields: { Status: "accepted", "Valid-From": OLD_START, "Valid-To": FAR_FUTURE },
      wikiFields: { Status: "accepted", ValidFrom: OLD_START, ValidTo: FAR_FUTURE },
      expectAdmit: true,
    },
    {
      name: "future: Valid-From later than ASOF is rejected on both surfaces (F-004: wiki used to admit it)",
      memoryFields: { Status: "accepted", "Valid-From": FAR_FUTURE },
      wikiFields: { Status: "accepted", ValidFrom: FAR_FUTURE },
      expectAdmit: false,
    },
    {
      name: "expired: Valid-To at/before ASOF is rejected on both surfaces (F-004: wiki used to admit it)",
      memoryFields: { Status: "accepted", "Valid-From": OLD_START, "Valid-To": ASOF },
      wikiFields: { Status: "accepted", ValidFrom: OLD_START, ValidTo: ASOF },
      expectAdmit: false,
    },
    {
      name: "deprecated: admitted at any ASOF (no interval restriction) -- agreed before and after the fix",
      memoryFields: { Status: "deprecated" },
      wikiFields: { Status: "deprecated" },
      expectAdmit: true,
    },
    {
      name: "conflict-shaped (accepted + unresolved supersededBy pointer): rejected at any ASOF on both surfaces (F-004: wiki used to admit it)",
      memoryFields: { Status: "accepted", "Superseded-By": "decisions/cycle-a.md" },
      wikiFields: { Status: "accepted", SupersededBy: "decisions/cycle-a.md" },
      expectAdmit: false,
    },
    {
      name: "superseded: accepted + a live supersededBy pointer is rejected at any ASOF on both surfaces (F-004: this is the finding's own example)",
      memoryFields: { Status: "accepted", "Superseded-By": "decisions/replacement.md" },
      wikiFields: { Status: "accepted", SupersededBy: "decisions/replacement.md" },
      expectAdmit: false,
    },
    {
      name: "malformed: an unparsable Valid-From is rejected at any ASOF on both surfaces (F-004: wiki used to admit it)",
      memoryFields: { Status: "accepted", "Valid-From": "not-a-date" },
      wikiFields: { Status: "accepted", ValidFrom: "not-a-date" },
      expectAdmit: false,
    },
  ];

  test.each(HISTORICAL_CLASSES.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, klass) => {
      const root = await mkdtemp(path.join(tmpdir(), "gd-lifecycle-parity-historical-"));
      try {
        await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
        await writeFile(
          path.join(root, ".metaproject", "memory", "decisions", "subject.md"),
          renderMemoryEntry("Subject entry", klass.memoryFields),
          "utf8",
        );
        await mkdir(path.join(root, ".metaproject", "wiki", "decisions"), { recursive: true });
        await writeFile(
          path.join(root, ".metaproject", "wiki", "decisions", "subject.md"),
          renderWikiPage("Subject page", klass.wikiFields),
          "utf8",
        );

        // `keryx memory search --as-of ASOF` -- the reference verdict.
        const entries = await collectEntries(root);
        const searchResults = searchEntries(entries, TAG, { asOf: ASOF }, DEFAULT_MEMORY_CONFIG, NOW);
        const memoryAdmitted = searchResults.some((r) => r.entry.relativePath === "decisions/subject.md");

        // `keryx wiki ask --as-of ASOF` -- both its memory-candidate pass
        // (over the SAME memory/decisions/subject.md file) and its
        // wiki-candidate pass (over the wiki-authored page).
        const askResult = await wikiAsk({ cwd: root, question: TAG, asOf: ASOF });
        const wikiAskMemoryAdmitted = askResult.citations.some((c) => c.path === "memory/decisions/subject.md");
        const wikiAskWikiAdmitted = askResult.citations.some((c) => c.path === "wiki/decisions/subject.md");

        expect(memoryAdmitted).toBe(klass.expectAdmit);
        // The core F-004 assertion: the SAME memory entry file must get the
        // SAME verdict from `memory search --as-of` and `wiki ask --as-of`.
        expect(wikiAskMemoryAdmitted).toBe(memoryAdmitted);
        expect(wikiAskWikiAdmitted).toBe(klass.expectAdmit);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

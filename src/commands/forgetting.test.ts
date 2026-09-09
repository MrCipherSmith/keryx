// Flow 242 T9/F3 + F9 — the trail's read surface, and the four surfaces that
// consult it.
//
// F9 was "the deletion trail has no read surface"; the programme's most-repeated
// defect is a capability whose only caller is its own test. So this file asserts
// reachability as well as behaviour: `forgetting lookup` is one caller, and
// `memory search`, `gdgraph affected` and `wiki check-links` are three more that
// reach the same module without the verb being typed. If someone deletes the
// wiring from any of them, a test here goes red rather than the capability
// quietly reverting to unreachable.
//
// F3 was the collapse: "deleted" and "never existed" gave one answer on every
// surface. Each surface below is asserted in BOTH states — a removed identity
// and one that was never recorded — because an assertion on only the removed
// case passes just as well on the old code that answered both the same way.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { forgettingCommand } from "./forgetting";
import { gdgraphCommand } from "./gdgraph";
import { memoryCommand } from "./memory";
import { wikiCommand } from "./wiki";
import { appendDeletionRecord, type DeletionRecord } from "../forgetting/journal";
import { formatMemory } from "../harness/tool/metaproject-operations";

const REMOVAL: Omit<DeletionRecord, "v"> = {
  at: "2026-09-08T12:00:00.000Z",
  observedBy: "keryx sync --apply",
  outcome: "propagated",
  removed: [
    {
      layer: "wiki-identity",
      ref: "keryx:page/billing",
      page: "architecture/billing.md",
      title: "Billing charges once",
    },
  ],
  // Journal v2 (T7): what the run saw removed and could NOT record. Empty here.
  observedUnrecorded: [],
  untouched: [{ layer: "memory", cause: "authored memory entries are never deleted by a wiki removal" }],
  requestedBy: { value: "aleks", basis: "stated", detail: "named on the command line (`--actor`)" },
  grounds: { value: "superseded by ADR-14", basis: "stated", detail: "given with the deletion (`--reason`)" },
  danglingAfter: 0,
  refusals: [],
};

let root = "";
let previousCwd = "";
let out: string[] = [];
let err: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-forgetting-cmd-"));
  previousCwd = process.cwd();
  process.chdir(root);
  out = [];
  err = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  // Assigning `undefined` does not clear `process.exitCode` in Bun; reset it.
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  process.chdir(previousCwd);
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

describe("keryx forgetting — the read surface F9 said did not exist", () => {
  test("lookup answers a recorded removal with when, who and why", async () => {
    await appendDeletionRecord(root, REMOVAL);
    await forgettingCommand(["lookup", "keryx:page/billing"]);

    const text = out.join("\n");
    expect(text).toContain("[recorded-removed]");
    expect(text).toContain("2026-09-08T12:00:00.000Z");
    expect(text).toContain("requested by: aleks [stated]");
    expect(text).toContain("grounds: superseded by ADR-14 [stated]");
    expect(process.exitCode).toBe(0);
  });

  test("lookup answers an unrecorded identity differently, and never claims it never existed", async () => {
    await appendDeletionRecord(root, REMOVAL);
    await forgettingCommand(["lookup", "keryx:page/never-written"]);

    const text = out.join("\n");
    // The paired assertion: this is the case the old surfaces could not tell
    // apart from the one above.
    expect(text).toContain("[no-removal-recorded]");
    expect(text).not.toContain("[recorded-removed]");
    expect(text).toContain("NOT the claim");
    expect(process.exitCode).toBe(0);
  });

  test("an unreadable trail exits 2 — the `cannot tell` code, not a clean 0", async () => {
    const file = path.join(root, ".metaproject", "data", "forgetting", "journal.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "this is not a record\n", "utf8");

    await forgettingCommand(["lookup", "keryx:page/billing"]);
    expect(out.join("\n")).toContain("[trail-unreadable]");
    // REVERT CHECK: returning 0 here — which every other completed lookup does
    // — makes this red. A caller scripting on the exit code would treat "I could
    // not read the history" as "there is no such removal".
    expect(process.exitCode).toBe(2);
  });

  test("trail --json reports coverage measured from the file", async () => {
    await appendDeletionRecord(root, REMOVAL);
    await forgettingCommand(["trail", "--json"]);

    const payload = JSON.parse(out.join("\n")) as {
      state: string;
      coverage: { records: number; layersWithRemovals: string[]; layersRecordedUntouched: string[] };
      scopeCaveat: string;
    };
    expect(payload.state).toBe("present");
    expect(payload.coverage.records).toBe(1);
    expect(payload.coverage.layersWithRemovals).toEqual(["wiki-identity"]);
    expect(payload.coverage.layersRecordedUntouched).toEqual(["memory"]);
    expect(payload.scopeCaveat).toContain("NOT the claim");
  });

  test("--search is a separate mode, never a silent fallback for an exact miss", async () => {
    await appendDeletionRecord(root, REMOVAL);

    await forgettingCommand(["lookup", "charges once"]);
    expect(out.join("\n")).toContain("[no-removal-recorded]");

    out = [];
    await forgettingCommand(["lookup", "charges once", "--search"]);
    expect(out.join("\n")).toContain("[recorded-removed]");
  });
});

describe("keryx memory search consults the trail on an empty result", () => {
  test("a phrase the trail records as removed no longer reads like a phrase that never existed", async () => {
    await appendDeletionRecord(root, REMOVAL);

    await memoryCommand(["search", "charges once"]);
    const removed = out.join("\n");
    out = [];
    await memoryCommand(["search", "quantum flux capacitor"]);
    const never = out.join("\n");

    // Both found nothing. Before this lane the two outputs were byte-identical.
    expect(removed).toContain("Results: 0");
    expect(never).toContain("Results: 0");
    // REVERT CHECK: deleting the `removalTrail` block from `runSearch` makes
    // this equality hold again — which is the blocker restated.
    expect(removed).not.toBe(never);
    expect(removed).toContain("[recorded-removed]");
    expect(never).toContain("[no-removal-recorded]");
    expect(never).toContain("NOT the claim");
  });

  test("the trail is NOT consulted when the search found something", async () => {
    await appendDeletionRecord(root, REMOVAL);
    await mkdir(path.join(root, ".metaproject", "memory", "decisions"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "memory", "decisions", "charges-once.md"),
      [
        "---",
        "id: charges-once",
        "type: decision",
        "title: Billing charges once",
        "status: accepted",
        "created: 2026-01-01",
        "summary: The billing path charges once per order.",
        "---",
        "",
        "## Decision",
        "",
        "Billing charges once per order.",
        "",
      ].join("\n"),
      "utf8",
    );

    await memoryCommand(["search", "charges once", "--json"]);
    const payload = JSON.parse(out.join("\n")) as {
      results: unknown[];
      removalTrail?: unknown;
    };
    expect(payload.results.length).toBeGreaterThan(0);
    // A hit already answers the caller. Appending removal history to it would be
    // noise, not the distinction this closes.
    expect(payload.removalTrail).toBeUndefined();
  });
});

describe("keryx gdgraph affected separates a removed path from one that never existed", () => {
  beforeEach(async () => {
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      '{"id":"src/orders.ts","kind":"file","path":"src/orders.ts","language":"typescript"}\n',
      "utf8",
    );
    // `src/orders.ts` still imports `./billing`; `src/billing.ts` was deleted, so
    // the build recorded the edge as unresolved.
    await writeFile(
      path.join(storage, "edges.jsonl"),
      '{"from":"src/orders.ts","to":"./billing","kind":"unresolved","specifier":"./billing"}\n',
      "utf8",
    );
  });

  test("the two answers differ, and the code stays in the closed vocabulary", async () => {
    await gdgraphCommand(["affected", "src/billing.ts", "--json"]);
    const deleted = JSON.parse(out.join("\n")) as {
      code: string;
      removal: { verdict: string; reason: string; referencedBy: Array<{ from: string; specifier: string }> };
    };
    out = [];
    await gdgraphCommand(["affected", "src/nonexistent.ts", "--json"]);
    const absent = JSON.parse(out.join("\n")) as { code: string; removal: { verdict: string } };

    // Unchanged: `target-not-indexed` is the norm's word for both, and inventing
    // a `target-removed` member of that closed union here would fork it.
    expect(deleted.code).toBe("target-not-indexed");
    expect(absent.code).toBe("target-not-indexed");
    // Changed: the distinction now travels in an additive field a caller can
    // branch on. REVERT CHECK: dropping the `removal` key restores the collapse.
    expect(deleted.removal.verdict).toBe("referenced-but-unindexed");
    expect(deleted.removal.referencedBy).toEqual([{ from: "src/orders.ts", specifier: "./billing" }]);
    expect(absent.removal.verdict).toBe("trail-absent");
    expect(deleted.removal.verdict).not.toBe(absent.removal.verdict);
  });

  test("the text form carries the same distinction on stderr", async () => {
    await gdgraphCommand(["affected", "src/billing.ts"]);
    const deleted = err.join("\n");
    err = [];
    await gdgraphCommand(["affected", "src/nonexistent.ts"]);
    const absent = err.join("\n");

    expect(deleted).toContain("code: target-not-indexed");
    expect(absent).toContain("code: target-not-indexed");
    expect(deleted).toContain("removal: [referenced-but-unindexed]");
    expect(absent).toContain("removal: [trail-absent]");
  });

  test("evidence is labelled as evidence, never sold as proof of a removal", async () => {
    await gdgraphCommand(["affected", "src/billing.ts", "--json"]);
    const payload = JSON.parse(out.join("\n")) as { removal: { reason: string } };
    // A misspelled import produces the same unresolved edge, so the verdict must
    // not be `recorded-removed` and the prose must say what it is worth.
    expect(payload.removal.reason).toContain("not proof of a removal");
  });
});

describe("keryx wiki check-links separates a tombstoned page from one that never existed", () => {
  test('"(target not found)" is no longer the whole answer for both', async () => {
    const wiki = path.join(root, ".metaproject", "wiki");
    await mkdir(path.join(wiki, "architecture"), { recursive: true });
    await writeFile(
      path.join(wiki, "index.md"),
      [
        "# Index",
        "",
        "- [Billing](architecture/billing.md)",
        "- [Never written](architecture/never-written.md)",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(wiki, ".sections.json"),
      JSON.stringify({
        version: 2,
        entries: [],
        tombstones: [
          {
            kind: "page",
            ref: "keryx:page/billing",
            page: "architecture/billing.md",
            title: "Billing",
            digest: null,
            registeredAt: "2026-01-01T00:00:00.000Z",
            removedAt: "2026-09-08T12:00:00.000Z",
            reason: 'page "Billing" is no longer present in the wiki',
          },
        ],
        lifted: [],
      }),
      "utf8",
    );

    await wikiCommand(["check-links"]);
    const text = out.join("\n");

    // Both links are broken and both still report the original reason — this
    // lane adds an explanation, it does not rewrite `WikiBrokenLink.reason`.
    expect(text).toContain("architecture/billing.md (target not found)");
    expect(text).toContain("architecture/never-written.md (target not found)");
    // REVERT CHECK: deleting the `explainBrokenLink` call from `runCheckLinks`
    // makes these two red, and the two links become indistinguishable again.
    expect(text).toContain("tombstoned: removed 2026-09-08T12:00:00.000Z");
    expect(text).toContain("trail-absent: neither the section registry nor the deletion trail");
    expect(text).toContain('NOT the claim "this never existed"');
  });
});

describe("the agent boundary renders the same distinction", () => {
  test("formatMemory prints the verdict as a tag, not a second generic sentence", () => {
    const removed = formatMemory({
      query: "charges once",
      hits: [],
      removalTrail: {
        verdict: "recorded-removed",
        summary: 'the deletion trail records anything matching "charges once" as REMOVED',
        totalRemovals: 1,
        removals: [
          {
            layer: "wiki-identity",
            ref: "keryx:page/billing",
            title: "Billing charges once",
            removedAt: "2026-09-08T12:00:00.000Z",
            observedBy: "keryx sync --apply",
            requestedBy: "aleks [stated]",
            grounds: "superseded by ADR-14 [stated]",
            matchedOn: "title",
          },
        ],
      },
    });
    const never = formatMemory({
      query: "quantum flux capacitor",
      hits: [],
      removalTrail: {
        verdict: "trail-absent",
        summary: "there is no deletion trail here … NOT the claim \"this never existed\"",
      },
    });

    expect(removed.output).not.toBe(never.output);
    expect(removed.output).toContain("[recorded-removed]");
    expect(removed.output).toContain("requested by: aleks [stated]");
    expect(never.output).toContain("[trail-absent]");
    // Neither is an error: the search completed, and "this was removed" is an
    // answer, not a failure.
    expect(removed.isError).toBe(false);
    expect(never.isError).toBe(false);
  });

  test("the projected summary is not clipped before the caveat that bounds it", async () => {
    await appendDeletionRecord(root, REMOVAL);
    const { createMetaprojectAdapter } = await import("../harness/tool/metaproject-adapter");
    const result = await createMetaprojectAdapter(root).memorySearch({ query: "quantum flux capacitor" });

    expect(result.hits).toEqual([]);
    expect(result.removalTrail?.verdict).toBe("no-removal-recorded");
    // REVERT CHECK: putting `MAX_EXCERPT_BYTES` back in place of
    // `MAX_REMOVAL_SUMMARY_BYTES` makes this red — measured, the summary was
    // being cut at `"No record of a removal"…`, one clause before the part that
    // stops a model reading the silence as proof.
    expect(result.removalTrail?.summary).toContain('NOT the claim "this never existed"');
    expect(result.removalTrail?.summary.endsWith("…")).toBe(false);
  });

  test("a port implementation without the field renders exactly as it always did", () => {
    // The field is optional at the type level so an out-of-tree `MetaprojectPort`
    // still type-checks; this pins that the old output is unchanged for it.
    expect(formatMemory({ query: "anything", hits: [] }).output).toBe(
      'No memory entries matched "anything".',
    );
  });
});

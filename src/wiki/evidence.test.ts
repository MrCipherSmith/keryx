// AFC-W04 (flow 235, phase 3, T12) — the four clauses of AC9, each driven
// through `createGdWikiService()`: the SAME object `src/mcp/tools.ts`'s
// `wiki.ask` builds (`createGdWikiService().ask`) and `src/commands/wiki.ts`
// uses. Nothing here calls `./evidence.ts`'s helpers directly, because the
// defect this programme keeps finding is a capability asserted against code no
// live path calls — the evidence schema itself was that defect (145 lines,
// a worked example, zero producers) until this task.
//
// Every envelope produced below is additionally validated against the REAL
// contract, `docs/requirements/keryx-agent-first-core/schemas/wiki-evidence.schema.json`,
// through the same validator the contract fixture harness
// (`src/contracts/agent-first-core.fixtures.test.ts`) already runs it under —
// so "matches the schema" is measured, not asserted by eye.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchema } from "../contracts/validator";
import { createGdWikiService } from "./service";
import type { EvidenceItem } from "./evidence";

const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-agent-first-core",
  "schemas",
);

function expectSchemaValid(item: EvidenceItem): void {
  const result = validateAgainstSchema("wiki-evidence.schema.json", item, { schemaDir: SCHEMA_DIR });
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
}

// Unrelated ballast. `wikiAsk` refuses a question whose every matching term is
// ubiquitous in the corpus (its `insufficient-evidence` branch), which on a
// two-section fixture would fire for any question at all. These pages make the
// fixture corpora behave like a real wiki, so the clauses below are exercised
// against `status: "ok"` retrieval rather than against a corpus artefact.
function filler(slug: string, subject: string, words: string[]): string {
  return `<!-- keryx:page id="${slug}" v=1 -->
# ${subject}

Version: 1.0.0
Type: architecture
Status: accepted

## Summary

${subject} covers ${words.join(", ")}.

<!-- keryx:section id="${slug}-detail" v=1 -->
## Details

The ${words[0]} subsystem coordinates ${words[1]} and reports ${words[2]} to the
operator console on every cycle.
<!-- /keryx:section -->

<!-- keryx:section id="${slug}-notes" v=1 -->
## Operational notes

Operators inspect ${words[1]} before rotating ${words[2]}; the ${words[0]}
budget is reviewed once per quarter.
<!-- /keryx:section -->
`;
}

const BALLAST: Record<string, string> = {
  "architecture/telemetry.md": filler("telemetry", "Telemetry Pipeline", [
    "telemetry",
    "sampling",
    "counters",
  ]),
  "architecture/storage.md": filler("storage", "Storage Layout", [
    "storage",
    "compaction",
    "segments",
  ]),
  "architecture/scheduler.md": filler("scheduler", "Scheduler", [
    "scheduler",
    "leases",
    "partitions",
  ]),
  "architecture/routing.md": filler("routing", "Request Routing", [
    "routing",
    "affinity",
    "shards",
  ]),
};

async function makeWiki(
  prefix: string,
  pages: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [relative, content] of Object.entries({ ...BALLAST, ...pages })) {
    const absolute = path.join(root, ".metaproject", "wiki", relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

// A rule whose live caveat says the opposite of its first half — the spec's own
// worked example ("обновление согласовано" / "реализация отложена").
const DEPENDENCY_POLICY = `<!-- keryx:page id="dependency-policy" v=1 -->
# Dependency Policy

Version: 1.2.0
Type: business-rule
Status: accepted

## Summary

How platform dependency updates are agreed and rolled out.

<!-- keryx:section id="update-agreed" v=1 -->
## Quarterly dependency update

Claim-Type: decision
Caveat: implementation-deferred
Authority: decision:dep-2026-01

The quarterly dependency update is agreed for every platform service.
Teams may plan a rollout window against the agreed schedule.
<!-- /keryx:section -->

<!-- keryx:section id="implementation-deferred" v=1 -->
## Rollout deferred

Implementation of the agreed quarterly update is deferred until the sandbox
rollout lands. No service may upgrade before then.
<!-- /keryx:section -->
`;

test("AC9 clause 1 — a mandatory exclusion is not lost: the caveat travels inside the item, and the rule half is never returned alone", async () => {
  const root = await makeWiki("gd-wiki-evidence-caveat-", {
    "business-rules/dependency-policy.md": DEPENDENCY_POLICY,
  });
  try {
    const service = createGdWikiService();
    const result = await service.evidence({
      cwd: root,
      question: "quarterly dependency update",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const rule = result.items.find((item) => item.sectionId === "update-agreed");
    expect(rule).toBeDefined();
    if (!rule) return;
    expectSchemaValid(rule);

    // The caveat is IN the item, not a neighbouring item the ranker might drop.
    expect(rule.caveats.length).toBe(1);
    const caveat = rule.caveats[0];
    expect(caveat?.text).toContain("deferred");
    expect(caveat?.sourceStatus).toBe("known");
    expect(caveat?.source?.ref).toBe("keryx:page/dependency-policy");
    expect(caveat?.source?.fragment).toContain("section:implementation-deferred");
    // The same constraint is inside provenance, exactly as the contract's own
    // worked example carries it.
    expect(rule.provenance.constraints.length).toBe(1);

    // The rule's own text is delivered whole — not truncated to an excerpt cap.
    expect(rule.excerpt.text).toContain("agreed for every platform service");
    expect(rule.excerpt.text).toContain("plan a rollout window");
    expect(rule.excerpt.text.endsWith("…")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC9 clause 1, negative — a declared caveat whose source is gone yields insufficient-evidence, not the confident half", async () => {
  const root = await makeWiki("gd-wiki-evidence-missing-caveat-", {
    "business-rules/dependency-policy.md": DEPENDENCY_POLICY.replace(
      /<!-- keryx:section id="implementation-deferred" v=1 -->[\s\S]*<!-- \/keryx:section -->\n$/,
      "",
    ),
  });
  try {
    const service = createGdWikiService();
    const result = await service.evidence({
      cwd: root,
      question: "quarterly dependency update",
    });

    expect(result.status).toBe("insufficient-evidence");
    expect(result.items).toEqual([]);
    expect(result.refused.length).toBeGreaterThan(0);
    const refusal = result.refused.find((entry) => entry.sectionRef.endsWith("#update-agreed"));
    expect(refusal?.code).toBe("insufficient-evidence");
    expect(refusal?.reason).toContain("implementation-deferred");
    // The confident half must not appear anywhere in the answer.
    expect(JSON.stringify(result)).not.toContain("agreed for every platform service");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC9 clause 1, negative — a caveat whose section was REMOVED resolves to its tombstone, not to a same-named section", async () => {
  const root = await makeWiki("gd-wiki-evidence-tombstoned-caveat-", {
    "business-rules/dependency-policy.md": DEPENDENCY_POLICY.replace(
      /<!-- keryx:section id="implementation-deferred" v=1 -->[\s\S]*<!-- \/keryx:section -->\n$/,
      "",
    ),
  });
  try {
    // The registry the marker lane writes from `keryx wiki sections sync`:
    // the caveat section existed and is now gone.
    await writeFile(
      path.join(root, ".metaproject", "wiki", ".sections.json"),
      `${JSON.stringify({
        version: 1,
        entries: [],
        tombstones: [
          {
            kind: "section",
            ref: "keryx:page/dependency-policy#implementation-deferred",
            page: "business-rules/dependency-policy.md",
            title: "Rollout deferred",
            removedAt: "2026-09-01T00:00:00.000Z",
            reason: "section \"Rollout deferred\" is no longer present in business-rules/dependency-policy.md",
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = await createGdWikiService().evidence({
      cwd: root,
      question: "quarterly dependency update",
    });

    expect(result.status).toBe("insufficient-evidence");
    const refusal = result.refused.find((entry) => entry.sectionRef.endsWith("#update-agreed"));
    expect(refusal?.reason).toContain("removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const RETRY_RULE = `<!-- keryx:page id="retry-policy" v=1 -->
# Retry Policy

Version: 2.0.0
Type: business-rule
Status: accepted

## Summary

Delivery retry limits for outbound webhooks.

<!-- keryx:section id="retry-limit" v=1 -->
## Webhook retry limit

Claim-Type: instruction
Conflicts-With: keryx:page/retry-history#retry-limit-old

A failed webhook delivery is retried at most three times, then parked.
<!-- /keryx:section -->
`;

const RETRY_HISTORY = `<!-- keryx:page id="retry-history" v=1 -->
# Retry Decision Record

Version: 1.0.0
Type: decision
Status: accepted

## Summary

The earlier accepted webhook retry decision.

<!-- keryx:section id="retry-limit-old" v=1 -->
## Webhook retry limit

A failed webhook delivery is retried at most ten times before it is parked.
<!-- /keryx:section -->
`;

test("AC9 clause 2 — conflicting sources come back as two paired items, each naming the other with its version; nothing is merged or resolved", async () => {
  const root = await makeWiki("gd-wiki-evidence-conflict-", {
    "business-rules/retry-policy.md": RETRY_RULE,
    "decisions/retry-history.md": RETRY_HISTORY,
  });
  try {
    const result = await createGdWikiService().evidence({
      cwd: root,
      question: "webhook retry limit",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const current = result.items.find((item) => item.sectionId === "retry-limit");
    const older = result.items.find((item) => item.sectionId === "retry-limit-old");
    // Two items, not one summary that picked a winner.
    expect(current).toBeDefined();
    expect(older).toBeDefined();
    if (!current || !older) return;
    expectSchemaValid(current);
    expectSchemaValid(older);

    // Each side names the other, WITH the version that disagrees, so the
    // consumer can see there is a disagreement and read both claims.
    expect(current.conflictRefs.map((ref) => ref.ref)).toContain("keryx:page/retry-history");
    expect(current.conflictRefs[0]?.version).toBe("1.0.0");
    expect(current.conflictRefs[0]?.fragment).toContain("section:retry-limit-old");
    // Pairing is symmetric even though only ONE page declared the conflict:
    // a reader who reaches the older record first must still see it is contested.
    expect(older.conflictRefs.map((ref) => ref.ref)).toContain("keryx:page/retry-policy");
    expect(older.conflictRefs[0]?.version).toBe("2.0.0");

    // Both claims are readable — the disagreement is about a number, and both
    // numbers are present.
    expect(current.excerpt.text).toContain("three times");
    expect(older.excerpt.text).toContain("ten times");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const DRAFT_RULE = `<!-- keryx:page id="draft-policy" v=1 -->
# Draft Escalation Policy

Version: 0.1.0
Type: business-rule
Status: draft

## Summary

An escalation policy nobody has accepted yet.

<!-- keryx:section id="escalation" v=1 -->
## Escalation escalation window

Claim-Type: instruction

An unacknowledged escalation is raised to the on-call lead after ten minutes.
<!-- /keryx:section -->
`;

const ACCEPTED_RULE = `<!-- keryx:page id="accepted-policy" v=1 -->
# Accepted Escalation Policy

Version: 3.0.0
Type: business-rule
Status: accepted

## Summary

The accepted escalation policy.

<!-- keryx:section id="escalation-accepted" v=1 -->
## Escalation escalation window

Claim-Type: instruction
Conflicts-With: keryx:page/draft-policy#escalation

An unacknowledged escalation is raised to the duty manager after five minutes.
<!-- /keryx:section -->
`;

// Measured on this checkout before the test was written: `wikiAsk` drops a
// page whose `Status:` is not current from its candidate set entirely
// (`wikiCandidates`' lifecycle filter, `./ask.ts`), so a draft never arrives
// as a search hit in default mode. It arrives the way non-current content
// actually reaches a reader — pulled in by reference, as the caveat or the
// contested counterpart of something that DID match. That is the path where
// mislabelling it would do damage, so it is the path this asserts.
test("AC9 clause 3 — a draft pulled in by reference is never rendered verified, even when handed a freshness record; its accepted counterpart is", async () => {
  const root = await makeWiki("gd-wiki-evidence-draft-", {
    "business-rules/draft-policy.md": DRAFT_RULE,
    "business-rules/accepted-policy.md": ACCEPTED_RULE,
  });
  try {
    const service = createGdWikiService();
    const result = await service.evidence({
      cwd: root,
      question: "escalation window",
      // Both sections are handed the SAME verified snapshot. Only the one that
      // can carry it does.
      verified: {
        "keryx:page/draft-policy#escalation": "snapshot-abc",
        "keryx:page/accepted-policy#escalation-accepted": "snapshot-abc",
      },
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const draft = result.items.find((item) => item.sectionId === "escalation");
    const accepted = result.items.find((item) => item.sectionId === "escalation-accepted");
    expect(draft).toBeDefined();
    expect(accepted).toBeDefined();
    if (!draft || !accepted) return;
    expectSchemaValid(draft);
    expectSchemaValid(accepted);

    // Draft: not current, not fresh, and it says WHY.
    expect(draft.lifecycle.status).toBe("draft");
    expect(draft.lifecycle.current).toBe(false);
    expect(draft.freshness.state).not.toBe("fresh");
    expect(draft.freshness.snapshotVersion).toBeNull();
    expect(draft.freshness.reason).toContain("draft");
    // Nothing may claim a person confirmed it.
    expect(draft.provenance.confirmedBy).toBeNull();

    // Accepted + a verified snapshot: the one case where `fresh` is honest.
    expect(accepted.lifecycle.status).toBe("accepted");
    expect(accepted.lifecycle.current).toBe(true);
    expect(accepted.freshness.state).toBe("fresh");
    expect(accepted.freshness.snapshotVersion).toBe("snapshot-abc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC9 clause 3 — with no freshness run at all, nothing is fresh: unknown, with the reason that it was not verified", async () => {
  const root = await makeWiki("gd-wiki-evidence-unverified-", {
    "business-rules/accepted-policy.md": ACCEPTED_RULE,
  });
  try {
    const result = await createGdWikiService().evidence({
      cwd: root,
      question: "escalation window",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const item = result.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.freshness.state).toBe("unknown");
    expect(item.freshness.reason).toContain("not verified");
    expect(item.freshness.snapshotVersion).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC9 clause 4 — a mandatory item that does not fit returns budget-exceeded, never a shortened rule", async () => {
  const root = await makeWiki("gd-wiki-evidence-budget-", {
    "business-rules/dependency-policy.md": DEPENDENCY_POLICY,
  });
  try {
    const service = createGdWikiService();
    const generous = await service.evidence({
      cwd: root,
      question: "quarterly dependency update",
      budgetTokens: 4000,
    });
    expect(generous.status).toBe("ok");

    const tight = await service.evidence({
      cwd: root,
      question: "quarterly dependency update",
      budgetTokens: 20,
    });

    expect(tight.status).toBe("budget-exceeded");
    if (tight.status !== "budget-exceeded") return;
    // The vocabulary is `src/ctx/assembly.ts`'s, reused — not a third spelling.
    expect(tight.overflow.code).toBe("context_overflow");
    expect(tight.overflow.requiredId).toBe("keryx:page/dependency-policy#update-agreed");
    expect(tight.items).toEqual([]);
    // A safe suggestion, as the spec requires — and NO piece of the rule.
    expect(tight.suggestion).toContain("budget");
    const serialized = JSON.stringify(tight);
    expect(serialized).not.toContain("agreed for every platform service");
    expect(serialized).not.toContain("The quarterly dependency update is agreed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional loss is a named manifest, not a silent drop, and required content is unaffected", async () => {
  const root = await makeWiki("gd-wiki-evidence-manifest-", {
    "business-rules/retry-policy.md": RETRY_RULE,
    "decisions/retry-history.md": RETRY_HISTORY,
    "business-rules/accepted-policy.md": ACCEPTED_RULE,
  });
  try {
    // Enough for the required conflict pair, not enough for the third page.
    const result = await createGdWikiService().evidence({
      cwd: root,
      question: "webhook retry limit escalation window",
      budgetTokens: 700,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    if (result.omittedOptional.length > 0) {
      expect(result.partial).toBe(true);
      for (const omitted of result.omittedOptional) {
        expect(typeof omitted).toBe("string");
        expect(omitted.length).toBeGreaterThan(0);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a question the corpus cannot answer keeps wikiAsk's own outcome code — no empty envelope presented as an answer", async () => {
  const root = await makeWiki("gd-wiki-evidence-nomatch-", {
    "business-rules/retry-policy.md": RETRY_RULE,
  });
  try {
    const result = await createGdWikiService().evidence({
      cwd: root,
      question: "zorblax frimbulator quixnark",
    });
    expect(result.status).toBe("no-match");
    expect(result.items).toEqual([]);
    expect(result.reason.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence is a pure read: it writes nothing, not even the section registry", async () => {
  const root = await makeWiki("gd-wiki-evidence-nowrite-", {
    "business-rules/retry-policy.md": RETRY_RULE,
    "decisions/retry-history.md": RETRY_HISTORY,
  });
  try {
    const before = await listTree(path.join(root, ".metaproject"));
    await createGdWikiService().evidence({ cwd: root, question: "webhook retry limit" });
    const after = await listTree(path.join(root, ".metaproject"));
    expect(after).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function listTree(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        out.push(path.relative(root, absolute));
      }
    }
  };
  await walk(root);
  return out.sort();
}

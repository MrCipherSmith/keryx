import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRaws } from "../commands/review-ledger";
import { type LedgerInputs, buildLedger, followUpsOf, parentFollowUps } from "./ledger";
import { researchErrors } from "./research";

const REPLIES = { files: new Set<string>(), reviewers: ["review-logic"] };
const SCHEMAS = [
  "src/gdskills/bundled/skills/review/review-orchestrator/reviewer-finding.schema.json",
  ".metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json",
];

function inputs(result: Record<string, unknown>, dispositions: LedgerInputs["dispositions"] = []): LedgerInputs {
  return {
    mode: "all",
    selected: ["review-logic"],
    manifest: undefined,
    payloadSlices: {},
    ruleFiles: { "review-logic": ".metaproject/skills/gdskills/review/review-logic/SKILL.md" },
    raws: [{ name: "raw/review-logic.txt", hash: "h1", mtimeMs: 1, empty: false, result: { reviewer: "review-logic", status: "DONE", summary: "s", findings: [], needs_context: [], ...result } }],
    retry: { schemaVersion: 1, reviewers: {} },
    canonical: [],
    dispositions,
    manifestPath: "slices/manifest.json",
  };
}

const FU1 = "review-logic:fu1";
const FU2 = "review-logic:fu2";
const closing = { evidence: "probe.log shows the call site is guarded", reason: "checked by the parent" };

describe("follow_ups in the result JSON", () => {
  test("each entry becomes an unresolved obligation <raw>:fu<N>, and the ledger is not reconciled", () => {
    const { ledger, gaps } = buildLedger(inputs({ follow_ups: ["check the caller in b.ts", "run the migration on a copy"] }));
    expect(ledger.obligations.map((o) => [o.id, o.status])).toEqual([[FU1, "unresolved"], [FU2, "unresolved"]]);
    expect(ledger.obligations[0]).toMatchObject({ source: "raw/review-logic.txt" });
    expect(String(ledger.obligations[0]?.question)).toContain("check the caller in b.ts");
    expect(ledger.rawReconciled).toBe(false);
    expect(gaps.filter((gap) => gap.detail.startsWith(FU1))).toHaveLength(1);
    expect(researchErrors({ ...ledger, scopeReviewed: true }, []).join(" ")).toContain(`${FU1}: unresolved research`);
  });

  test("a result without follow-ups builds exactly the ledger it built before", () => {
    const plain = buildLedger(inputs({}));
    expect(plain.ledger.obligations).toEqual([]);
    expect(plain.ledger.rawReconciled).toBe(true);
    expect(buildLedger(inputs({ follow_ups: [] }))).toEqual(plain);
  });

  test("blank and non-string entries are not obligations", () => {
    const { ledger } = buildLedger(inputs({ follow_ups: ["", "  ", 7, null, "real one"] }));
    expect(ledger.obligations.map((o) => o.id)).toEqual([FU1]);
  });

  test("a disposition closes it, a narrowed one only with its 'what remains' text", () => {
    const closed = buildLedger(inputs({ follow_ups: ["x"] }, [{ id: FU1, status: "refuted", ...closing }]));
    expect(closed.ledger.obligations[0]).toMatchObject({ id: FU1, status: "refuted", ...closing });
    expect(closed.ledger.rawReconciled).toBe(true);
    expect(closed.gaps).toEqual([]);

    const bare = buildLedger(inputs({ follow_ups: ["x"] }, [{ id: FU1, status: "narrowed", ...closing }]));
    expect(bare.ledger.obligations[0]).toMatchObject({ status: "unresolved" });
    expect(bare.ledger.rawReconciled).toBe(false);

    const narrowed = buildLedger(inputs({ follow_ups: ["x"] }, [{ id: FU1, status: "narrowed", ...closing, remains: "b.ts:9 is still unguarded" }]));
    expect(narrowed.ledger.obligations[0]).toMatchObject({ status: "narrowed", remains: "b.ts:9 is still unguarded" });
    expect(narrowed.ledger.rawReconciled).toBe(true);
  });

  test("it never closes by itself: a canonical finding with a matching id does not close it, and one open follow-up keeps the ledger open", () => {
    const canonical = [{ id: "fu1", reviewer: "review-logic" }];
    const { ledger } = buildLedger({ ...inputs({ follow_ups: ["a", "b"] }, [{ id: FU1, status: "out-of-scope", ...closing }]), canonical });
    expect(ledger.obligations.map((o) => o.status)).toEqual(["out-of-scope", "unresolved"]);
    expect(ledger.rawReconciled).toBe(false);
  });

  test("the follow-up ids do not collide with finding ids", () => {
    const finding = { id: "L-01", severity: "major", problem: "p" };
    const { ledger } = buildLedger(inputs({ findings: [finding], follow_ups: ["a"] }));
    expect(ledger.obligations.map((o) => o.id)).toEqual(["review-logic:L-01", FU1]);
  });
});

describe("Parent follow-up: lines", () => {
  const block = ["```REVIEW_RESULT", JSON.stringify({ reviewer: "review-logic", status: "DONE", summary: "s", findings: [] }), "```"].join("\n");

  test("only lines after the REVIEW_RESULT block count", () => {
    const body = ["I will end with a Parent follow-up: line.", "Parent follow-up: before the block, quoted in prose", block, "Parent follow-up: check the retry cap in queue.ts", "- Parent follow-up: rerun the e2e suite", "> **Parent follow-up:** confirm the flag default"].join("\n");
    expect(parentFollowUps(body)).toEqual(["check the retry cap in queue.ts", "rerun the e2e suite", "confirm the flag default"]);
  });

  test("text that only mentions the phrase is not a follow-up", () => {
    expect(parentFollowUps(`${block}\nThere is no Parent follow-up: needed here.\nParent follow-up:   \n`)).toEqual([]);
  });

  test("the result's own follow_ups come first, and the same text is counted once", () => {
    const result = { reviewer: "review-logic", status: "DONE", follow_ups: ["a", "b"] };
    expect(followUpsOf(result, `${block}\nParent follow-up: b\nParent follow-up: c`)).toEqual(["a", "b", "c"]);
  });

  describe("read from a raw file", () => {
    const dirs: string[] = [];
    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });
    async function load(body: string) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "keryx-follow-ups-"));
      dirs.push(dir);
      await mkdir(path.join(dir, "raw"));
      await writeFile(path.join(dir, "raw", "review-logic.txt"), body);
      return (await loadRaws(dir, REPLIES)).raws;
    }

    test("the line becomes an obligation through the ledger build", async () => {
      const raws = await load(`${block}\nParent follow-up: check the caller in b.ts\n`);
      expect(raws[0]?.result?.follow_ups).toEqual(["check the caller in b.ts"]);
      const { ledger } = buildLedger({ ...inputs({}), raws });
      expect(ledger.obligations).toMatchObject([{ id: FU1, status: "unresolved" }]);
      expect(ledger.rawReconciled).toBe(false);
    });

    test("a reply with no such line parses to the same result as before", async () => {
      const raws = await load(`${block}\nAll done.\n`);
      expect(raws[0]?.result).toEqual({ reviewer: "review-logic", status: "DONE", summary: "s", findings: [] });
      expect("follow_ups" in raws[0]!.result!).toBe(false);
    });
  });
});

describe("reviewer-finding.schema.json", () => {
  test("every copy declares follow_ups as an array of strings, and the copies agree", async () => {
    const texts = await Promise.all(SCHEMAS.map((file) => readFile(path.join(import.meta.dir, "../..", file), "utf8")));
    for (const text of texts) {
      const schema = JSON.parse(text) as { properties: Record<string, { type?: string; items?: { type?: string } }> };
      expect(schema.properties.follow_ups).toMatchObject({ type: "array", items: { type: "string" } });
    }
    expect(texts[1]).toBe(texts[0]!);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRaws } from "../commands/review-ledger";
import { requiredReviewers } from "./coverage";
import { buildLedger, type LedgerInputs } from "./ledger";
import type { MutationRecord } from "./mutate";
import { researchErrors } from "./research";
import { buildReviewScope } from "./scope";
import { auditSeverity } from "./severity-audit";

/**
 * A replay of the pull request that exposed the gaps this flow closes, rebuilt from invented files: a two-line comment
 * added to a page, a new user-visible row, a body with "Documentation needed" unticked, a reply with a
 * `Parent follow-up:` line, and a surviving mutant that only changes presentation. No network, no real project.
 */
const FIXTURES = path.join(import.meta.dir, "fixtures", "pr-replay");
const FOLLOW_UP = "review-testing-practices:fu1";
const REPLIES = { files: new Set<string>(), reviewers: ["review-testing-practices"] };

let root: string;
const dirs: string[] = [];

async function install(name: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-pr-replay-"));
  dirs.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  for (const name of ["review-orchestrator", "review-verifier", "review-logic", "review-frontend", "review-style", "review-pr-contract", "review-testing-practices"]) await install(name);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const read = (name: string) => readFile(path.join(FIXTURES, name), "utf8");

async function loadReply() {
  await mkdir(path.join(root, "raw"), { recursive: true });
  await writeFile(path.join(root, "raw", "review-testing-practices.txt"), await read("raw-reply.txt"), "utf8");
  return (await loadRaws(root, REPLIES)).raws;
}

function ledgerInputs(raws: LedgerInputs["raws"], dispositions: LedgerInputs["dispositions"] = []): LedgerInputs {
  return {
    mode: "all",
    selected: ["review-testing-practices"],
    manifest: undefined,
    payloadSlices: {},
    ruleFiles: { "review-testing-practices": ".metaproject/skills/gdskills/review/review-testing-practices/SKILL.md" },
    raws,
    retry: { schemaVersion: 1, reviewers: {} },
    canonical: [{ id: "F-010", reviewer: "review-testing-practices", severity: "minor" }],
    dispositions,
    manifestPath: "slices/manifest.json",
  };
}

describe("PR replay (synthetic)", () => {
  test("the pre-filter keeps the two-line comment hunk when the comment rule is on, and drops it when it is off", async () => {
    const diff = await read("change.diff");
    const off = buildReviewScope(diff);
    expect(off.drops.some((drop) => drop.reason === "comment-only")).toBe(true);

    const on = buildReviewScope(diff, { retainCommentBlocks: true });
    expect(on.kept?.map((k) => k.reason)).toEqual(["kept:comment-rule"]);
    expect(on.kept?.[0]).toMatchObject({ path: "src/admin/ExamplePage.tsx", changedLines: 2 });
    expect(on.counts.keptByReason).toEqual({ "kept:comment-rule": 1 });
    expect(on.drops).toEqual([]);
    expect(on.regions.map((region) => region.text).join("\n")).toContain("The last-seen value mirrors the sign-in audit log");
  });

  test("the Parent follow-up line is an obligation the ledger holds open until a disposition closes it", async () => {
    const raws = await loadReply();
    expect(raws[0]?.result?.follow_ups).toEqual([expect.stringContaining("sign-in audit log writer was not read")]);

    const held = buildLedger(ledgerInputs(raws));
    expect(held.ledger.obligations.find((o) => o.id === FOLLOW_UP)).toMatchObject({ status: "unresolved" });
    expect(held.ledger.rawReconciled).toBe(false);
    expect(held.gaps.some((gap) => gap.detail.startsWith(FOLLOW_UP))).toBe(true);
    expect(researchErrors({ ...held.ledger, scopeReviewed: true }, []).join(" ")).toContain(`${FOLLOW_UP}: unresolved research`);

    const closed = buildLedger(ledgerInputs(raws, [{ id: FOLLOW_UP, status: "refuted", evidence: "docs/audit-log.md", reason: "the writer sets lastSeen on creation" }]));
    expect(closed.ledger.obligations.find((o) => o.id === FOLLOW_UP)).toMatchObject({ status: "refuted" });
    expect(closed.gaps.filter((gap) => gap.detail.startsWith(FOLLOW_UP))).toEqual([]);
  });

  test("a surviving presentation mutant leaves the minor finding minor and writes a held note", async () => {
    const record = JSON.parse(await read("mutation-1.json")) as MutationRecord;
    const [finding] = (await loadReply())[0]!.result!.findings!;
    const changedFiles = buildReviewScope(await read("change.diff"), { retainCommentBlocks: true }).files;

    const { findings, changes } = auditSeverity([finding!], [{ name: "mutation-1.json", record }], { changedFiles });
    expect(findings[0]?.severity).toBe("minor");
    expect(findings[0]?.severity_audit).toEqual({
      held: { severity: "minor", mutant: "m1", kind: "presentation", evidence: "mutation-1.json#m1", reason: "mutant m1 survived but only changes presentation: severity held" },
    });
    expect(changes).toEqual([expect.objectContaining({ id: "F-010", from: "minor", to: "minor", held: true })]);
  });

  test("review-pr-contract is selected because the package holds the PR body with Documentation needed unticked", async () => {
    const body = await read("pr-context.md");
    expect(body).toMatch(/^- \[ \] Documentation needed$/m);
    const need = await requiredReviewers(root, "all", ["src/admin/ExamplePage.tsx"], { prContext: true });
    expect(need.required).toContain("review-pr-contract");
  });
});

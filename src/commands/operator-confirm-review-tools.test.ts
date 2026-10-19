// Flow 456 (AC2, AC4): the four review gates as operator-confirmed tools. Each is driven the way the agent loop drives it:
// `confirmation` builds the card from the package on disk, and `invoke` with the card's token applies the effect in process.
// A "no" never reaches `invoke`, so the package must be byte-for-byte what it was.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { READY_COVERAGE_MD, READY_DISPATCH } from "../review/dispatch.test-helpers";
import { createManagedReviewPackage } from "../review/managed";
import { ensureChunkPlan } from "../review/chunks";
import { readChunkEstimate } from "../review/chunks-estimate";
import { computeCoverage, readCoverageWaiver } from "../review/coverage-complete";
import { heldFinding, heldPremise } from "../review/premise-fixtures";
import { computeReadiness } from "../review/readiness";
import { computeVerdict } from "../review/verdict";
import type { PostResult, ReviewEvent } from "../review/publish";
import { buildReviewConfirmSpecs, reviewConfirmSpecs } from "./operator-confirm-review";
import { operatorConfirmTool, operatorConfirmToolNames } from "./operator-confirm-tools";

const NOW = new Date("2026-10-15T19:00:00.000Z");
const PR = "https://github.com/Presight-AI/vantage-frontend/pull/7932";
const ALLOWED_ID = 446593035;
const PRESSED_AT = "2026-10-15T19:00:05.000Z";

let root: string;
let pkg: string;
const posts: Array<{ ref: string; event: ReviewEvent; body: string }> = [];

const post = async (ref: string, event: ReviewEvent, body: string): Promise<PostResult> => {
  posts.push({ ref, event, body });
  return { ok: true, detail: "ok" };
};

function tool(name: string, seams: Partial<Parameters<typeof buildReviewConfirmSpecs>[0]> = {}): InteractiveTool {
  const spec = buildReviewConfirmSpecs({ prLookup: async () => null, prFiles: async () => null, postReview: post, ...seams }).find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no spec ${name}`);
  return operatorConfirmTool(spec, { projectRoot: root, now: () => NOW, env: {}, allowedUserIds: () => [ALLOWED_ID] });
}

type Asked = { card: readonly string[]; title: string; token: string };

/** Ask for the card. A refusal comes back as `{ error }`. */
async function ask(t: InteractiveTool, input: Record<string, unknown>): Promise<Asked | { error: string }> {
  const result = await t.confirmation!(input);
  return result as Asked | { error: string };
}

const asked = (value: Asked | { error: string }): Asked => {
  if ("error" in value) throw new Error(`expected a card, got a refusal: ${value.error}`);
  return value;
};

async function yes(t: InteractiveTool, input: Record<string, unknown>, via?: "remote", pressedBy: number = ALLOWED_ID): Promise<{ output: string; isError?: boolean; card: readonly string[] }> {
  const card = asked(await ask(t, input));
  const press = via === undefined ? {} : { confirmationVia: via, confirmationPressedBy: pressedBy, confirmationPressedAt: PRESSED_AT };
  const result = await t.invoke(input, { confirmationToken: card.token, ...press } as never);
  return { output: result.output, isError: result.isError ?? false, card: card.card };
}

const read = (name: string): string => readFileSync(path.join(pkg, name), "utf8");
const readJson = (name: string): Record<string, any> => JSON.parse(read(name)) as Record<string, any>;
const put = (name: string, value: unknown): void => {
  mkdirSync(path.dirname(path.join(pkg, name)), { recursive: true });
  writeFileSync(path.join(pkg, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

beforeEach(() => {
  posts.length = 0;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-confirm-review-")));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".metaproject"));
  pkg = path.join(root, ".metaproject", "reviews", "pr7932-r1");
  mkdirSync(pkg, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the review gates are registered and listed for the unattended refusal", () => {
  const names = reviewConfirmSpecs().map((spec) => spec.name);
  expect(names).toEqual([
    "review_chunks_answer",
    "review_publish",
    "review_waive_coverage",
    "review_waive_readiness",
    "review_waive_mutation",
    "review_override_reviewers",
    "review_comments_reply",
    "review_confirm_plan",
    "review_decide_premise",
    "review_complete",
  ]);
  for (const name of names) expect(operatorConfirmToolNames()).toContain(name);
});

describe("review_chunks_answer", () => {
  function dropFiles(count: number): void {
    const dropped = Array.from({ length: count }, (_, index) => ({ file: `src/d-${String(index).padStart(4, "0")}.ts`, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" }));
    put("blast-radius.json", { schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped });
  }

  test("the card shows the pass count over the ceiling; yes records the answer, the card quote and confirmedVia", async () => {
    dropFiles(1100);
    await ensureChunkPlan(pkg, root);
    const t = tool("review_chunks_answer");
    const result = await yes(t, { package: pkg, answer: "yes" });
    expect(result.card[0]).toBe("Allow 28 review passes, over the 25-pass ceiling, for .metaproject/reviews/pr7932-r1?");
    expect(result.card.join("\n")).toContain("passes requested: 28");
    expect(result.card.join("\n")).toContain("ceiling: 25 passes (1000 files), from the default; 3 over");
    expect(result.card.at(-1)).toBe("subject: package .metaproject/reviews/pr7932-r1");
    expect(result.isError).toBe(false);
    const record = await readChunkEstimate(pkg);
    expect(record?.answer).toEqual({
      value: "yes",
      quote: "Allow 28 review passes, over the 25-pass ceiling, for .metaproject/reviews/pr7932-r1?: yes",
      at: NOW.toISOString(),
      confirmedVia: "tui-card",
    });
  });

  test("a yes answered in the remote topic is recorded as remote-card; answer=no records a declined run", async () => {
    dropFiles(1100);
    await ensureChunkPlan(pkg, root);
    const t = tool("review_chunks_answer");
    const result = await yes(t, { package: pkg, answer: "no" }, "remote");
    expect(result.card[0]).toContain("Stop the 28-pass chunk run");
    const answer = (await readChunkEstimate(pkg))?.answer;
    expect(answer?.value).toBe("no");
    expect(answer?.confirmedVia).toBe("remote-card");
    expect(answer?.pressedBy).toBe(ALLOWED_ID);
    expect(answer?.pressedAt).toBe(PRESSED_AT);
  });

  test("a no changes nothing: the card was built, the tool was never invoked, no estimate is on disk", async () => {
    dropFiles(1100);
    await ensureChunkPlan(pkg, root);
    const t = tool("review_chunks_answer");
    const card = asked(await ask(t, { package: pkg, answer: "yes" }));
    t.confirmationDeclined!(card.token);
    expect(existsSync(path.join(pkg, "chunk-estimate.json"))).toBe(false);
    // A declined card's token is dead: replaying it applies nothing.
    const replay = await t.invoke({ package: pkg, answer: "yes" }, { confirmationToken: card.token } as never);
    expect(replay.isError).toBe(true);
    expect(existsSync(path.join(pkg, "chunk-estimate.json"))).toBe(false);
  });

  test("asking never writes chunks.json: no plan yet is a refusal naming the command, and a no leaves the package as it was", async () => {
    dropFiles(1100);
    const t = tool("review_chunks_answer");
    const refused = await ask(t, { package: pkg, answer: "yes" });
    expect(refused).toEqual({ error: expect.stringContaining("keryx review chunks plan") });
    expect(existsSync(path.join(pkg, "chunks.json"))).toBe(false);
    // With a plan on disk, the card is built and a no adds no file.
    await ensureChunkPlan(pkg, root);
    const before = readdirSync(pkg).sort();
    const card = asked(await ask(t, { package: pkg, answer: "yes" }));
    t.confirmationDeclined!(card.token);
    expect(readdirSync(pkg).sort()).toEqual(before);
  });

  test("a run within the ceiling is refused: there is no question to answer", async () => {
    dropFiles(100);
    await ensureChunkPlan(pkg, root);
    const refused = await ask(tool("review_chunks_answer"), { package: pkg, answer: "yes" });
    expect(refused).toEqual({ error: expect.stringContaining("within the ceiling of 25") });
  });

  test("a package that is not a directory in the project is refused", async () => {
    const refused = await ask(tool("review_chunks_answer"), { package: "/etc", answer: "yes" });
    expect("error" in refused).toBe(true);
  });
});

describe("review_publish", () => {
  function makePackage(): void {
    put("manifest.json", {
      schemaVersion: 1,
      reviewId: "pr7932-r1",
      mode: "review-flow",
      status: "draft",
      target: { kind: "pr", ref: PR },
      artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
      coverage: [],
    });
    put("findings.json", [{ id: "f-1", severity: "major", title: "unverified claim" }]);
    put("report.md", "# Review\n\nRequest changes.\n");
    put("coverage.md", "# Reviewer Coverage\n\nreviewer: review-logic\nstatus: run\nreason: read the diff\n");
  }

  test("the card shows the target PR, the verdict, partial and the body size; yes posts exactly the shown body and records confirmedVia", async () => {
    makePackage();
    const t = tool("review_publish");
    const result = await yes(t, { package: pkg, event: "REQUEST_CHANGES", partial: true });
    const text = result.card.join("\n");
    expect(result.card[0]).toBe(`Post this REQUEST_CHANGES review (PARTIAL) to ${PR}?`);
    expect(text).toContain(`target: ${PR}`);
    expect(text).toContain("verdict: REQUEST_CHANGES");
    expect(text).toContain("partial: yes — readiness is failing: verifier");
    expect(text).toMatch(/body: \d+ characters, \d+ lines/);
    expect(text).toContain("**Partial review.**");
    expect(result.isError).toBe(false);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ ref: PR, event: "REQUEST_CHANGES" });
    expect(posts[0]!.body.startsWith("**Partial review.**")).toBe(true);
    expect(readJson("published.json")).toMatchObject({ pr: PR, event: "REQUEST_CHANGES", partial: true, failing: ["verifier"], time: NOW.toISOString(), confirmedVia: "tui-card" });
  });

  test("a no posts nothing and writes nothing", async () => {
    makePackage();
    const t = tool("review_publish");
    const card = asked(await ask(t, { package: pkg, partial: true }));
    t.confirmationDeclined!(card.token);
    expect(posts).toEqual([]);
    expect(existsSync(path.join(pkg, "published.json"))).toBe(false);
  });

  test("a failing checklist without partial is refused, naming the failing item; nothing is asked", async () => {
    makePackage();
    const refused = await ask(tool("review_publish"), { package: pkg });
    expect(refused).toEqual({ error: expect.stringMatching(/cannot publish[\s\S]*verifier/i) });
    expect(posts).toEqual([]);
  });

  test("the manifest target changing between the card and the yes posts nothing", async () => {
    makePackage();
    const t = tool("review_publish");
    const input = { package: pkg, partial: true };
    const card = asked(await ask(t, input));
    const manifest = readJson("manifest.json");
    manifest["target"] = { kind: "pr", ref: "https://github.com/Presight-AI/vantage-frontend/pull/9999" };
    put("manifest.json", manifest);
    const result = await t.invoke(input, { confirmationToken: card.token } as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("changed after the card was shown");
    expect(posts).toEqual([]);
    expect(existsSync(path.join(pkg, "published.json"))).toBe(false);
  });

  test("the report changing between the card and the yes posts nothing", async () => {
    makePackage();
    const t = tool("review_publish");
    const input = { package: pkg, partial: true };
    const card = asked(await ask(t, input));
    put("report.md", "# Review\n\nApproved, actually.\n");
    const result = await t.invoke(input, { confirmationToken: card.token } as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("changed after the card was shown");
    expect(posts).toEqual([]);
    expect(existsSync(path.join(pkg, "published.json"))).toBe(false);
  });
});

describe("review_waive_coverage", () => {
  const slice = (id: string, files: string[]) => ({ id, path: `slices/${id}`, bytes: 10, contentHash: id, files, domain: "d", split: "file" });
  function uncovered(): void {
    put("scope-files.json", { files: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    put("slice-manifest.json", {
      schemaVersion: 1,
      maxBytes: 1000,
      waveBytes: 1000,
      source: "diff",
      slices: [slice("s1", ["src/a.ts"])],
      omissions: [],
      totals: { slices: 1, bytes: 10, files: 1, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
    });
    put("research.json", { dispatch: { version: 1, mode: "all", selected: ["review-logic"], runs: [{ reviewer: "review-logic", status: "complete", scopeComplete: true, coveredSlices: ["s1"] }] } });
  }

  test("the card lists the uncovered files; yes records the quote, the files and confirmedVia, and the gate then passes", async () => {
    uncovered();
    const t = tool("review_waive_coverage");
    const result = await yes(t, { package: pkg });
    const text = result.card.join("\n");
    expect(result.card[0]).toBe("Accept 2 uncovered file(s) as not reviewed in .metaproject/reviews/pr7932-r1?");
    expect(text).toContain("2 of 3 in-scope files");
    expect(text).toContain("  src/b.ts");
    expect(text).toContain("  src/c.ts");
    expect(text).not.toContain("src/a.ts");
    expect(result.isError).toBe(false);
    const waiver = readCoverageWaiver(readJson("research.json").dispatch);
    expect(waiver).toEqual({
      operatorQuote: "Accept 2 uncovered file(s) as not reviewed in .metaproject/reviews/pr7932-r1?: yes",
      time: NOW.toISOString(),
      files: ["src/b.ts", "src/c.ts"],
      confirmedVia: "tui-card",
    });
    expect((await computeCoverage(pkg)).waived).toBe(true);
  });

  test("a no leaves research.json untouched", async () => {
    uncovered();
    const before = read("research.json");
    const t = tool("review_waive_coverage");
    t.confirmationDeclined!(asked(await ask(t, { package: pkg })).token);
    expect(read("research.json")).toBe(before);
    expect((await computeCoverage(pkg)).waived).toBe(false);
  });

  test("nothing uncovered is a refusal", async () => {
    uncovered();
    put("scope-files.json", { files: ["src/a.ts"] });
    const refused = await ask(tool("review_waive_coverage"), { package: pkg });
    expect(refused).toEqual({ error: expect.stringContaining("nothing to waive") });
  });

  test("the files changing between the card and the yes records nothing", async () => {
    uncovered();
    const t = tool("review_waive_coverage");
    const card = asked(await ask(t, { package: pkg }));
    put("scope-files.json", { files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] });
    const result = await t.invoke({ package: pkg }, { confirmationToken: card.token } as never);
    expect(result.isError).toBe(true);
    expect(readCoverageWaiver(readJson("research.json").dispatch)).toBeUndefined();
  });
});

describe("review_waive_readiness", () => {
  function makePackage(): void {
    put("manifest.json", {
      schemaVersion: 1,
      reviewId: "pr7932-r1",
      mode: "review-flow",
      status: "draft",
      target: { kind: "pr", ref: PR },
      artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
      coverage: [],
    });
    put("findings.json", [{ id: "f-1", severity: "major", title: "unverified claim" }]);
    put("report.md", "# Review\n\nRequest changes.\n");
    put("coverage.md", "# Reviewer Coverage\n\nreviewer: review-logic\nstatus: run\nreason: read the diff\n");
  }

  test("the card names the item and its current failing detail; yes records the waiver with confirmedVia and the report header", async () => {
    makePackage();
    const t = tool("review_waive_readiness");
    const result = await yes(t, { package: pkg, item: "verifier" });
    const text = result.card.join("\n");
    expect(result.card[0]).toBe("Accept failing readiness item 4 (verifier) of .metaproject/reviews/pr7932-r1 as it is?");
    expect(text).toContain("item 4 verifier:");
    expect(text).toContain("failing: ");
    expect(text).toContain("repair would be:");
    expect(result.card.at(-1)).toBe("subject: package .metaproject/reviews/pr7932-r1, item verifier");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Call review_complete to close the review.");
    expect(result.output).not.toContain("keryx review complete");
    expect(readJson("manifest.json").readiness_waivers).toEqual([
      { item: "verifier", operator_quote: "Accept failing readiness item 4 (verifier) of .metaproject/reviews/pr7932-r1 as it is?: yes", time: NOW.toISOString(), confirmedVia: "tui-card" },
    ]);
    expect(read("report.md").startsWith("Partial review: verifier waived by the operator:")).toBe(true);
  });

  test("the manifest schema accepts a readiness waiver a card recorded, tui or remote with the press fields", () => {
    const schema = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json"), "utf8")) as { properties: { readiness_waivers: Record<string, unknown> } };
    const base = { item: "verifier", operator_quote: "Accept it?: yes", time: NOW.toISOString() };
    const waivers = [{ ...base, confirmedVia: "tui-card" }, { ...base, confirmedVia: "remote-card", pressedBy: ALLOWED_ID, pressedAt: PRESSED_AT }, base];
    expect(validateAgainstSchemaObject(schema.properties.readiness_waivers, waivers).errors).toEqual([]);
    expect(validateAgainstSchemaObject(schema.properties.readiness_waivers, [{ ...base, confirmedVia: "somewhere" }]).errors).not.toEqual([]);
  });

  test("a no changes nothing", async () => {
    makePackage();
    const manifest = read("manifest.json");
    const report = read("report.md");
    const t = tool("review_waive_readiness");
    t.confirmationDeclined!(asked(await ask(t, { package: pkg, item: "4" })).token);
    expect(read("manifest.json")).toBe(manifest);
    expect(read("report.md")).toBe(report);
  });

  test("item 11 (premise-decisions) is refused before a card is drawn, naming review_decide_premise (review RG2-003)", async () => {
    makePackage();
    put("findings.json", [heldFinding({ global_id: "pr7932-r1#LY-003" })]);
    const t = tool("review_waive_readiness");
    for (const item of ["premise-decisions", "11"]) {
      expect(await ask(t, { package: pkg, item })).toEqual({ error: expect.stringContaining("review_decide_premise") });
    }
    expect(readJson("manifest.json").readiness_waivers).toBeUndefined();
  });

  test("an item that passes, an unknown item and an already waived item are refusals", async () => {
    makePackage();
    const t = tool("review_waive_readiness");
    expect(await ask(t, { package: pkg, item: "coverage-md" })).toEqual({ error: expect.stringContaining("nothing to waive") });
    expect(await ask(t, { package: pkg, item: "no-such-item" })).toEqual({ error: expect.stringContaining("not a readiness item") });
    await yes(t, { package: pkg, item: "verifier" });
    expect(await ask(t, { package: pkg, item: "verifier" })).toEqual({ error: expect.stringContaining("already waived") });
  });
});

// Flow 459 (AC3): review_decide_premise, the operator's answer to a finding the premise judge held.
describe("review_decide_premise", () => {
  const held = heldFinding({ global_id: "pr7932-r1#LY-003", premise: heldPremise({ question: "Should the timeline mirror?" }) });

  function makePackage(findings: unknown[] = [held]): void {
    put("manifest.json", {
      schemaVersion: 1,
      reviewId: "pr7932-r1",
      mode: "review-flow",
      status: "draft",
      target: { kind: "pr", ref: PR },
      artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
      coverage: [],
    });
    put("findings.json", findings);
  }
  const readiness = async () => (await computeReadiness(pkg)).items.find((item) => item.id === "premise-decisions");

  test("the card shows the finding and the judge's question; yes records the answer with confirmedVia and clears readiness", async () => {
    makePackage();
    expect((await readiness())?.status).toBe("fail");
    const t = tool("review_decide_premise");
    const result = await yes(t, { package: pkg, finding: "LY-003", answer: "dismiss", reason: "platforms do not mirror media controls" });
    const text = result.card.join("\n");
    expect(result.card[0]).toBe("Dismiss finding pr7932-r1#LY-003 in .metaproject/reviews/pr7932-r1 as incorrect?");
    expect(text).toContain("finding: pr7932-r1#LY-003 (major): timeline pinned LTR");
    expect(text).toContain("premise judge: challenged: Should the timeline mirror?");
    expect(text).toContain("reason: platforms do not mirror media controls");
    expect(result.isError).toBe(false);
    const decisions = readJson("operator-decisions.json").decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "premise-question", finding: "pr7932-r1#LY-003", answer: "dismiss", reason: "platforms do not mirror media controls", at: NOW.toISOString(), actor: "operator", confirmedVia: "tui-card" });
    // The operator's words are the card they said yes to, as for the sibling decisions.
    expect(decisions[0].quote).toContain(result.card[0]);
    expect(decisions[0].subject).toMatchObject({ severity: "major", verdict: "challenged" });
    expect(readJson("findings.json")[0].disposition.state).toBe("dismissed-incorrect");
    expect((await readiness())?.status).toBe("pass");
  });

  test("uphold keeps the original severity and a remote yes is recorded as remote-card", async () => {
    makePackage();
    const t = tool("review_decide_premise");
    const result = await yes(t, { package: pkg, finding: "pr7932-r1#LY-003", answer: "uphold", reason: "mirror it" }, "remote");
    expect(result.card[0]).toBe("Uphold finding pr7932-r1#LY-003 in .metaproject/reviews/pr7932-r1 at major?");
    expect(readJson("operator-decisions.json").decisions[0]).toMatchObject({ answer: "uphold", confirmedVia: "remote-card", pressedBy: ALLOWED_ID, pressedAt: PRESSED_AT });
    expect((await computeVerdict(pkg)).open.map((entry) => [entry.id, entry.severity])).toEqual([["LY-003", "major"]]);
  });

  test("a no records nothing", async () => {
    makePackage();
    const t = tool("review_decide_premise");
    t.confirmationDeclined!(asked(await ask(t, { package: pkg, finding: "LY-003", answer: "dismiss", reason: "r" })).token);
    expect(existsSync(path.join(pkg, "operator-decisions.json"))).toBe(false);
    expect((await readiness())?.status).toBe("fail");
  });

  test("an unknown finding, a finding that is not held, a missing reason and a bad answer are refusals", async () => {
    makePackage([held, { ...held, id: "LY-004", global_id: "pr7932-r1#LY-004", premise: { verdict: "upheld", judge: "review-premise" } }]);
    const t = tool("review_decide_premise");
    expect(await ask(t, { package: pkg, finding: "LY-999", answer: "dismiss", reason: "r" })).toEqual({ error: expect.stringContaining("No finding") });
    expect(await ask(t, { package: pkg, finding: "LY-004", answer: "dismiss", reason: "r" })).toEqual({ error: expect.stringContaining("not held") });
    expect(await ask(t, { package: pkg, finding: "LY-003", answer: "dismiss" })).toEqual({ error: expect.stringContaining("reason is required") });
    expect(await ask(t, { package: pkg, finding: "LY-003", answer: "maybe", reason: "r" })).toEqual({ error: expect.stringContaining("uphold") });
  });

  test("the answer is refused when the finding changed after the card was shown", async () => {
    makePackage();
    const t = tool("review_decide_premise");
    const input = { package: pkg, finding: "LY-003", answer: "dismiss", reason: "r" };
    const card = asked(await ask(t, input));
    put("findings.json", [{ ...held, severity: "minor" }]);
    const result = await t.invoke(input, { confirmationToken: card.token } as never);
    expect(result.isError).toBe(true);
    expect(existsSync(path.join(pkg, "operator-decisions.json"))).toBe(false);
  });

  test("a change to the problem or the judge's question after the card was shown also refuses", async () => {
    const verdictChanged = { ...held, premise: heldPremise({ verdict: "owner-decision", question: "Should the timeline mirror?", options: ["mirror", "keep LTR"] }) };
    for (const changed of [{ ...held, problem: "a different defect" }, { ...held, premise: heldPremise({ question: "a different question?" }) }, verdictChanged]) {
      makePackage();
      const t = tool("review_decide_premise");
      const input = { package: pkg, finding: "LY-003", answer: "dismiss", reason: "r" };
      const card = asked(await ask(t, input));
      put("findings.json", [changed]);
      const result = await t.invoke(input, { confirmationToken: card.token } as never);
      expect(result.isError).toBe(true);
      expect(existsSync(path.join(pkg, "operator-decisions.json"))).toBe(false);
    }
  });
});

// Flow 464 (AC3): the plan and premise cards answer through the remote card, per tool, both paths, "no" included.
describe("review_confirm_plan and review_decide_premise through the remote card", () => {
  const held = heldFinding({ global_id: "pr7932-r1#LY-003", premise: heldPremise({ question: "Should the timeline mirror?" }) });

  function overThresholdPackage(): void {
    put("manifest.json", {
      schemaVersion: 1,
      reviewId: "pr7932-r1",
      mode: "review-flow",
      status: "draft",
      target: { kind: "pr", ref: PR },
      artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
      coverage: [],
    });
    put("findings.json", [held]);
    writeFileSync(path.join(root, "routing.config.json"), JSON.stringify({ reviewPlan: { maxDispatches: 1, maxMinutes: 1 } }));
  }

  const planFile = (): Record<string, any> | undefined => (existsSync(path.join(pkg, "plan-confirmation.json")) ? readJson("plan-confirmation.json") : undefined);
  const premiseInput = { package: "", finding: "LY-003", answer: "dismiss", reason: "platforms do not mirror" };

  test("confirm_plan: a local yes records tui-card with no press; a remote yes records remote-card, who and when", async () => {
    overThresholdPackage();
    const t = tool("review_confirm_plan");
    expect((await yes(t, { package: pkg })).isError).toBe(false);
    expect(planFile()).toMatchObject({ confirmedVia: "tui-card" });
    expect(planFile()?.["pressedBy"]).toBeUndefined();
    rmSync(path.join(pkg, "plan-confirmation.json"));
    const remote = await yes(t, { package: pkg }, "remote");
    expect(remote.isError).toBe(false);
    expect(planFile()).toMatchObject({ confirmedVia: "remote-card", pressedBy: ALLOWED_ID, pressedAt: PRESSED_AT });
  });

  test("confirm_plan: a no, local or remote, records nothing", async () => {
    overThresholdPackage();
    const t = tool("review_confirm_plan");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      t.confirmationDeclined!(asked(await ask(t, { package: pkg })).token);
      expect(planFile()).toBeUndefined();
    }
  });

  test("confirm_plan: a remote yes from an id outside the allowed list records nothing and says why", async () => {
    overThresholdPackage();
    const result = await yes(tool("review_confirm_plan"), { package: pkg }, "remote", 1234);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Telegram user 1234 is not on the allowed list");
    expect(planFile()).toBeUndefined();
  });

  test("decide_premise: a local yes records tui-card with no press; a remote yes records remote-card, who and when", async () => {
    overThresholdPackage();
    const t = tool("review_decide_premise");
    const input = { ...premiseInput, package: pkg };
    expect((await yes(t, input)).isError).toBe(false);
    expect(readJson("operator-decisions.json").decisions[0]).toMatchObject({ confirmedVia: "tui-card" });
    expect(readJson("operator-decisions.json").decisions[0].pressedBy).toBeUndefined();
    expect((await yes(t, { ...input, answer: "uphold" }, "remote")).isError).toBe(false);
    const decisions = readJson("operator-decisions.json").decisions;
    expect(decisions.at(-1)).toMatchObject({ answer: "uphold", confirmedVia: "remote-card", pressedBy: ALLOWED_ID, pressedAt: PRESSED_AT });
  });

  test("decide_premise: a no, local or remote, records nothing", async () => {
    overThresholdPackage();
    const t = tool("review_decide_premise");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      t.confirmationDeclined!(asked(await ask(t, { ...premiseInput, package: pkg })).token);
      expect(existsSync(path.join(pkg, "operator-decisions.json"))).toBe(false);
    }
  });

  test("decide_premise: a remote yes from an id outside the allowed list records nothing and says why", async () => {
    overThresholdPackage();
    const result = await yes(tool("review_decide_premise"), { ...premiseInput, package: pkg }, "remote", 1234);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Telegram user 1234 is not on the allowed list");
    expect(existsSync(path.join(pkg, "operator-decisions.json"))).toBe(false);
  });
});

// Flow 464 (AC4): review_complete, the one card that closes a round.
describe("review_complete", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const EVIDENCE = "Evidence level: static only — did not run: tests";

  async function makeRound(over: { target?: { kind: "pr" | "report"; ref: string; head?: string }; report?: string; id?: string; findings?: Array<Record<string, unknown>> } = {}): Promise<string> {
    mkdirSync(path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas"), { recursive: true });
    writeFileSync(path.join(root, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"), `{"type":"object"}`);
    const created = await createManagedReviewPackage({
      cwd: root,
      mode: "ingest",
      reviewId: over.id ?? "2026-10-15-complete",
      target: over.target ?? { kind: "report", ref: "review.md" },
      reportText: over.report ?? `# Round\n\nNo findings.\n${EVIDENCE}\n`,
      findings: (over.findings ?? []) as never,
      now: NOW,
    });
    pkg = path.join(root, created.path);
    put("research.json", { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH });
    put("coverage.md", READY_COVERAGE_MD);
    if (over.target === undefined) put("manifest.json", { ...readJson("manifest.json"), target: { kind: "pr", ref: PR, head: HEAD } });
    return pkg;
  }

  const status = (): string => readJson("manifest.json")["status"] as string;

  test("the card shows the head SHA and the evidence level; with no waiver it says so; yes closes the round and records who pressed", async () => {
    await makeRound();
    const result = await yes(tool("review_complete"), { package: pkg }, "remote");
    const text = result.card.join("\n");
    expect(result.card[0]).toContain(`Complete review 2026-10-15-complete at ${HEAD.slice(0, 12)}?`);
    expect(text).toContain(`reviewed head: ${HEAD}`);
    expect(text).toContain(EVIDENCE);
    expect(text).toContain("waivers: none");
    expect(result.output).toContain("complete at 0123456789ab (remote-card");
    expect(result.isError).toBe(false);
    expect(status()).toBe("closed");
    const record = readJson("completion-confirmation.json");
    expect(record).toMatchObject({ confirmedVia: "remote-card", pressedBy: ALLOWED_ID, pressedAt: PRESSED_AT, head: HEAD, waivers: [] });
  });

  test("a tui yes records no press fields", async () => {
    await makeRound();
    await yes(tool("review_complete"), { package: pkg });
    expect(status()).toBe("closed");
    const record = readJson("completion-confirmation.json");
    expect(record["confirmedVia"]).toBe("tui-card");
    expect(record).not.toHaveProperty("pressedBy");
  });

  test("the card lists every readiness waiver (item and quote) and the coverage waiver", async () => {
    await makeRound();
    const manifest = readJson("manifest.json");
    manifest["readiness_waivers"] = [
      { item: "verifier", operator_quote: "Accept failing readiness item 4 (verifier) as it is?: yes", time: NOW.toISOString(), confirmedVia: "tui-card" },
      { item: "ledger", operator_quote: "Accept failing readiness item 7 (ledger) as it is?: yes", time: NOW.toISOString(), confirmedVia: "tui-card" },
    ];
    put("manifest.json", manifest);
    const research = readJson("research.json");
    research["dispatch"] = { ...(research["dispatch"] ?? {}), coverageWaiver: { operatorQuote: "Waive coverage of 2 files?: yes", time: NOW.toISOString(), files: ["src/a.ts", "src/b.ts"] } };
    put("research.json", research);
    const card = asked(await ask(tool("review_complete"), { package: pkg })).card.join("\n");
    expect(card).toContain('waiver: readiness item verifier: "Accept failing readiness item 4 (verifier) as it is?: yes"');
    expect(card).toContain('waiver: readiness item ledger: "Accept failing readiness item 7 (ledger) as it is?: yes"');
    expect(card).toContain('waiver: coverage, 2 file(s) not reviewed: "Waive coverage of 2 files?: yes"');
    expect(card).not.toContain("waivers: none");
  });

  test("the card lists the mutation waiver and the reviewer override from operator-decisions.json, with item and quote", async () => {
    await makeRound();
    put("operator-decisions.json", {
      schemaVersion: 1,
      decisions: [
        { kind: "mutation-waiver", quote: "Waive the mutation pass?: yes", reason: "no time", confirmedVia: "tui-card", at: NOW.toISOString(), subject: { head: HEAD, items: ["m1", "m2"] } },
        { kind: "reviewer-override", quote: "Run a smaller reviewer set?: yes", reason: "small diff", confirmedVia: "remote-card", at: NOW.toISOString(), subject: { head: HEAD, items: ["review-security-code"] } },
      ],
    });
    const card = asked(await ask(tool("review_complete"), { package: pkg })).card.join("\n");
    expect(card).toContain('waiver: mutation pass not run m1, m2: "Waive the mutation pass?: yes" (tui-card)');
    expect(card).toContain('waiver: reviewer override, left out review-security-code: "Run a smaller reviewer set?: yes" (remote-card)');
    expect(card).not.toContain("waivers: none");
  });

  test("an operator decision added between the card and the yes records nothing", async () => {
    await makeRound();
    const t = tool("review_complete");
    const card = asked(await ask(t, { package: pkg }));
    put("operator-decisions.json", {
      schemaVersion: 1,
      decisions: [{ kind: "mutation-waiver", quote: "sneaked in", reason: "x", confirmedVia: "tui-card", at: NOW.toISOString(), subject: { head: HEAD, items: ["m1"] } }],
    });
    const result = await t.invoke({ package: pkg }, { confirmationToken: card.token } as never);
    expect(result.isError).toBe(true);
    expect(existsSync(path.join(pkg, "completion-confirmation.json"))).toBe(false);
  });

  test("a research.json that cannot be read is shown as such, not as 'waivers: none'", async () => {
    await makeRound();
    writeFileSync(path.join(pkg, "research.json"), "{ not json");
    const card = asked(await ask(tool("review_complete"), { package: pkg })).card.join("\n");
    expect(card).toContain("waiver: coverage, could not read research.json");
    expect(card).not.toContain("waivers: none");
  });

  const GLOBAL = "2026-10-15-complete#review-logic-w1:F-001";
  const F1 = { id: "review-logic-w1:F-001", reviewer: "review-logic", severity: "minor", problem: "p", impact: "i", suggested_fix: "f", evidence: "e", confidence: "high" };

  test("dispositions: the card lists each one, and yes records them on the findings as the terminal command does", async () => {
    await makeRound({ findings: [F1] });
    const input = { package: pkg, dispositions: [{ finding: GLOBAL, disposition: "acted-on", evidence: "closed by 380bf3b0" }] };
    const result = await yes(tool("review_complete"), input);
    expect(result.card.join("\n")).toContain(`disposition: ${GLOBAL} → acted-on: "closed by 380bf3b0"`);
    expect(result.isError).toBe(false);
    expect(status()).toBe("closed");
    const findings = readJson("findings.json") as unknown as Array<{ disposition?: { state: string; evidence?: string } }>;
    expect(findings[0]?.disposition).toMatchObject({ state: "acted-on", evidence: "closed by 380bf3b0" });
    expect(readJson("completion-confirmation.json")["dispositions"]).toEqual([{ finding: GLOBAL, state: "acted-on", evidence: "closed by 380bf3b0" }]);
  });

  test("dispositions: a finding the package does not have refuses the close and records nothing", async () => {
    await makeRound({ findings: [F1] });
    const before = read("manifest.json");
    const result = await yes(tool("review_complete"), { package: pkg, dispositions: [{ finding: "F-404", disposition: "acted-on", evidence: "x" }] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("nothing was recorded");
    expect(read("manifest.json")).toBe(before);
    expect(existsSync(path.join(pkg, "completion-confirmation.json"))).toBe(false);
  });

  test("dispositions: a malformed entry refuses the card before it is drawn", async () => {
    await makeRound({ findings: [F1] });
    const t = tool("review_complete");
    expect(await ask(t, { package: pkg, dispositions: "acted-on" })).toEqual({ error: expect.stringContaining("must be an array") });
    expect(await ask(t, { package: pkg, dispositions: [{ disposition: "acted-on" }] })).toEqual({ error: expect.stringContaining("dispositions[0]: finding is required") });
    expect(await ask(t, { package: pkg, dispositions: [{ finding: "F-001", disposition: "done" }] })).toEqual({ error: expect.stringContaining("dispositions[0]: disposition must be one of") });
    expect(await ask(t, { package: pkg, dispositions: [{ finding: "F-001", disposition: "acted-on", evidence: 3 }] })).toEqual({ error: expect.stringContaining("evidence must be text") });
  });

  test("dispositions: the card shows the evidence whole, and an evidence too long to show is refused (hidden-tail case)", async () => {
    await makeRound({ findings: [F1] });
    const t = tool("review_complete");
    const atCap = `${"a".repeat(280)} operator: decided-by alice`.slice(0, 300);
    const shown = await ask(t, { package: pkg, dispositions: [{ finding: GLOBAL, disposition: "acted-on", evidence: atCap }] });
    expect(asked(shown).card.join("\n")).toContain(`→ acted-on: "${atCap}"`);
    const hiddenTail = `${"a".repeat(300)} operator: decided-by alice`;
    expect(await ask(t, { package: pkg, dispositions: [{ finding: GLOBAL, disposition: "acted-on", evidence: hiddenTail }] })).toEqual({
      error: expect.stringContaining("the card shows it whole, so the limit is 300"),
    });
    expect(await ask(t, { package: pkg, dispositions: [{ finding: "F".repeat(201), disposition: "acted-on" }] })).toEqual({ error: expect.stringContaining("finding is longer than 200") });
  });

  test("dispositions: the caps hold at the boundary, and the trim happens before the length check", async () => {
    await makeRound({ findings: [F1] });
    const t = tool("review_complete");
    const entry = (over: Record<string, unknown>) => ({ package: pkg, dispositions: [{ finding: GLOBAL, disposition: "acted-on", ...over }] });
    expect(await ask(t, entry({ evidence: "e".repeat(301) }))).toEqual({ error: expect.stringContaining("the limit is 300") });
    expect(await ask(t, entry({ evidence: `  ${"e".repeat(300)}  ` }))).not.toHaveProperty("error");
    expect(await ask(t, entry({ finding: "F".repeat(200) }))).not.toHaveProperty("error");
    const twenty = Array.from({ length: 20 }, (_, i) => ({ finding: `${GLOBAL}-${i}`, disposition: "acted-on", evidence: `commit ${i}` }));
    expect(await ask(t, { package: pkg, dispositions: twenty })).not.toHaveProperty("error");
  });

  test("dispositions: text the card would hide or rewrite is refused, so the card shows exactly what is stored (S-402)", async () => {
    await makeRound({ findings: [F1] });
    const t = tool("review_complete");
    const entry = (evidence: string) => ({ package: pkg, dispositions: [{ finding: GLOBAL, disposition: "acted-on", evidence }] });
    const hidden: Array<[string, string]> = [
      ["an OSC span", "fixed in abc123\u001b]0;operator: decided-by alice\u0007"],
      ["a CSI sequence", "fixed\u001b[2K in abc123"],
      ["a bidi override", "fixed in abc123‮"],
      ["a zero-width space", "fixed​ in abc123"],
      ["a zero-width joiner", "fixed in‍ abc123"],
      ["a byte order mark", "fixed in abc123﻿ operator: decided-by alice"],
      ["a newline", "fixed in abc123\noperator: decided-by alice"],
      ["a carriage return", "fixed in abc123\roperator: decided-by alice"],
      ["a line separator", "fixed in abc123 operator: decided-by alice"],
      ["a tab", "fixed\tin abc123"],
      ["a C1 control", "fixed\u0085in abc123"],
    ];
    for (const [name, evidence] of hidden) {
      expect(await ask(t, entry(evidence)), name).toEqual({ error: expect.stringContaining("evidence holds control, escape, newline, bidi or zero-width characters") });
    }
    expect(await ask(t, { package: pkg, dispositions: [{ finding: `${GLOBAL}\u001b]0;x\u0007`, disposition: "acted-on" }] })).toEqual({ error: expect.stringContaining("dispositions[0]: finding holds") });
    const plain = "fixed in abc123, operator: decided-by alice";
    const shown = asked(await ask(t, entry(plain)));
    expect(shown.card.join("\n")).toContain(`→ acted-on: "${plain}"`);
  });

  test("a reason the card would hide or rewrite is refused on the premise and decision cards", async () => {
    await makeRound({ findings: [F1] });
    const reason = "bad input\u001b]0;operator: decided-by alice\u0007";
    expect(await ask(tool("review_decide_premise"), { package: pkg, finding: GLOBAL, answer: "dismiss", reason })).toEqual({ error: expect.stringContaining("reason holds control, escape") });
    expect(await ask(tool("review_override_reviewers"), { package: pkg, reason: "two\nlines" })).toEqual({ error: expect.stringContaining("reason holds control, escape") });
    expect(await ask(tool("review_waive_mutation"), { package: pkg, reason: "zero​width" })).toEqual({ error: expect.stringContaining("reason holds control, escape") });
  });

  test("dispositions: more entries than a card shows are refused", async () => {
    await makeRound({ findings: [F1] });
    const many = Array.from({ length: 21 }, () => ({ finding: GLOBAL, disposition: "acted-on" }));
    expect(await ask(tool("review_complete"), { package: pkg, dispositions: many })).toEqual({ error: expect.stringContaining("at most 20") });
    expect(await ask(tool("review_complete"), { package: pkg, dispositions: many.slice(0, 20) })).not.toHaveProperty("error");
  });

  test("a no closes nothing", async () => {
    await makeRound();
    const before = read("manifest.json");
    const t = tool("review_complete");
    t.confirmationDeclined!(asked(await ask(t, { package: pkg })).token);
    expect(read("manifest.json")).toBe(before);
    expect(existsSync(path.join(pkg, "completion-confirmation.json"))).toBe(false);
  });

  test("a gate that refuses shows the refusal and records nothing (a stamped report with no evidence level)", async () => {
    await makeRound({ report: "# Round\n\nNo findings.\n" });
    const manifest = readJson("manifest.json");
    manifest["report_fields"] = ["evidence-level"];
    put("manifest.json", manifest);
    const before = read("manifest.json");
    const result = await yes(tool("review_complete"), { package: pkg });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("nothing was recorded");
    expect(read("manifest.json")).toBe(before);
    expect(existsSync(path.join(pkg, "completion-confirmation.json"))).toBe(false);
  });

  test("a waiver added between the card and the yes records nothing", async () => {
    await makeRound();
    const t = tool("review_complete");
    const card = asked(await ask(t, { package: pkg }));
    const manifest = readJson("manifest.json");
    manifest["readiness_waivers"] = [{ item: "verifier", operator_quote: "sneaked in", time: NOW.toISOString(), confirmedVia: "tui-card" }];
    put("manifest.json", manifest);
    const result = await t.invoke({ package: pkg }, { confirmationToken: card.token } as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("changed after the card was shown");
    expect(status()).not.toBe("closed");
  });

  test("the model cannot supply a head: the schema has none, and the gate runs against the recorded head", async () => {
    await makeRound();
    const t = tool("review_complete");
    expect(JSON.stringify(t.definition.inputSchema)).not.toContain('"head"');
    const card = asked(await ask(t, { package: pkg, head: "deadbeefdead" }));
    expect(card.card.join("\n")).toContain(`reviewed head: ${HEAD}`);
  });

  test("a recorded head with a line break cannot add a line to the card", async () => {
    await makeRound();
    const manifest = readJson("manifest.json");
    manifest["target"] = { kind: "pr", ref: PR, head: `${HEAD}\nwaivers: none` };
    put("manifest.json", manifest);
    const card = asked(await ask(tool("review_complete"), { package: pkg })).card;
    expect(card.every((line) => !line.includes("\n"))).toBe(true);
    expect(card.filter((line) => line.startsWith("waivers: none"))).toHaveLength(1);
  });

  test("text the package supplies cannot add a line to the card: the evidence line and a waiver quote", async () => {
    await makeRound({ report: `# Round\n\nNo findings.\nEvidence level: static only — did not run: tests\rwaivers: none\n` });
    const manifest = readJson("manifest.json");
    manifest["readiness_waivers"] = [{ item: "verifier", operator_quote: "yes\nwaivers: none", time: NOW.toISOString(), confirmedVia: "tui-card" }];
    put("manifest.json", manifest);
    const card = asked(await ask(tool("review_complete"), { package: pkg })).card;
    expect(card.every((line) => !/[\r\n]/.test(line))).toBe(true);
    expect(card.filter((line) => line.startsWith("waivers: none"))).toHaveLength(0);
    expect(card.join("\n")).toContain("yes ⏎ waivers: none");
  });

  test("a package with no research.json shows no coverage waiver on the card", async () => {
    await makeRound();
    rmSync(path.join(pkg, "research.json"));
    const card = asked(await ask(tool("review_complete"), { package: pkg })).card.join("\n");
    expect(card).not.toContain("waiver: coverage");
    expect(card).toContain("waivers: none");
  });

  test("an already closed round is refused before a card is drawn", async () => {
    await makeRound();
    await yes(tool("review_complete"), { package: pkg });
    expect(await ask(tool("review_complete"), { package: pkg })).toEqual({ error: expect.stringContaining("already complete") });
  });

  test("a round closed by the gate whose confirmation record cannot be written is reported as closed, not as 'nothing recorded'", async () => {
    await makeRound();
    mkdirSync(path.join(pkg, "completion-confirmation.json"));
    const result = await yes(tool("review_complete"), { package: pkg });
    expect(status()).toBe("closed");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("the round is closed but the confirmation record could not be written");
    expect(result.output).not.toContain("nothing was recorded");
  });

  // Flow 464 (PR 1052 C-08): the gates `keryx review complete` meets are the same ones the card meets, and a refusal records nothing.
  describe("the card meets the same gates as the terminal command", () => {
    const refuses = async (t: InteractiveTool, text: string): Promise<void> => {
      const before = read("manifest.json");
      const result = await yes(t, { package: pkg });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(text);
      expect(result.output).toContain("nothing was recorded");
      expect(read("manifest.json")).toBe(before);
      expect(status()).not.toBe("closed");
      expect(existsSync(path.join(pkg, "completion-confirmation.json"))).toBe(false);
    };

    test("a merged pull request is refused", async () => {
      await makeRound();
      await refuses(tool("review_complete", { prLookup: async () => ({ exists: true, state: "MERGED", headSha: HEAD }) }), "merged");
    });

    test("a head that moved is refused", async () => {
      await makeRound();
      await refuses(tool("review_complete", { prLookup: async () => ({ exists: true, state: "OPEN", headSha: "f".repeat(40) }) }), "fffffff");
    });

    test("a held finding the operator has not answered is refused (the premise rule, never waived through this card)", async () => {
      await makeRound();
      put("findings.json", [heldFinding({ global_id: "pr7932-r1#LY-003" })]);
      await refuses(tool("review_complete"), "premise-decisions");
    });

    test("a package stamped with the operator gate and no run-profile.json is refused", async () => {
      await makeRound();
      put("manifest.json", { ...readJson("manifest.json"), operatorGate: 1 });
      await refuses(tool("review_complete"), "run-profile.json");
    });

    test("a slice the manifest routes narrower than its content needs is refused", async () => {
      await makeRound();
      put("slices/manifest.json", { slices: [{ id: "s1", path: "s1.diff", roles: [], depth: "light" }] });
      put("slices/s1.diff", "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+import { spawn } from \"node:child_process\";\n+spawn(process.argv[2]);\n");
      await refuses(tool("review_complete"), "slices/manifest.json");
    });
  });
});

// Flow 456 (AC2, AC4): the four review gates as operator-confirmed tools. Each is driven the way the agent loop drives it:
// `confirmation` builds the card from the package on disk, and `invoke` with the card's token applies the effect in process.
// A "no" never reaches `invoke`, so the package must be byte-for-byte what it was.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
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

function tool(name: string): InteractiveTool {
  const spec = buildReviewConfirmSpecs({ prLookup: async () => null, prFiles: async () => null, postReview: post }).find((entry) => entry.name === name);
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
    expect(readJson("manifest.json").readiness_waivers).toEqual([
      { item: "verifier", operator_quote: "Accept failing readiness item 4 (verifier) of .metaproject/reviews/pr7932-r1 as it is?: yes", time: NOW.toISOString(), confirmedVia: "tui-card" },
    ]);
    expect(read("report.md").startsWith("Partial review: verifier waived by the operator:")).toBe(true);
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

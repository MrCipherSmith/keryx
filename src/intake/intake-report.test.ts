// AC20 (flow 403): the usefulness report. Per kind: decisions, median time to answer, how often the choice matched the
// suggestion; the card -> flow -> PR chain; and not one title, body or assessment anywhere in it or in the ledger.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIntakeReport, formatIntakeReport, median } from "./report";
import { runIntakePoll } from "./poll";
import { appendIntakeIfState, intakeLedgerPath, readIntakeLedgerCards } from "./store";
import { FakeGh, FakeSink, TestClock, depsFor, fakeAssessor, issuesJson, local, reviewsJson, setupIntakeEnv, takeBaseline, testConfig, type IntakeTestEnv } from "./intake.test-helpers";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  env.setBoard([]);
});
afterEach(async () => {
  await env.teardown();
});

async function decide(cardId: string, choice: string, afterMs: number, extra: { flowId?: string; state?: "decided" | "taken" } = {}): Promise<void> {
  const card = (await readIntakeLedgerCards(env.root)).find((c) => c.cardId === cardId)!;
  const decidedAt = new Date(Date.parse(card.sentAt!) + afterMs).toISOString();
  const r = await appendIntakeIfState(env.root, cardId, ["sent"], { state: extra.state ?? "decided", at: decidedAt, decidedAt, decidedBy: "446593035", choice: choice as never, ...(extra.flowId !== undefined ? { flowId: extra.flowId } : {}) });
  expect(r.ok).toBe(true);
}

async function setup(): Promise<{ ids: string[]; reviewId: string }> {
  const gh = new FakeGh();
  const clock = new TestClock(local(12));
  const sink = new FakeSink();
  const deps = depsFor(env, { gh, clock, sink, assess: fakeAssessor({ suggestion: "take" }).assess, config: testConfig() });
  await takeBaseline(env.root, deps, clock);
  gh.set("issue", issuesJson([1, 2, 3].map((n) => ({ number: n, title: `Secret title ${n}`, updatedAt: `2026-10-05T0${n}:00:00Z`, body: `Secret body ${n}` }))));
  gh.set("review", reviewsJson([{ number: 30, title: "Secret review title", updatedAt: "2026-10-05T04:00:00Z" }]));
  const result = await runIntakePoll(env.root, deps);
  expect(result.sent).toBe(4);
  const cards = await readIntakeLedgerCards(env.root);
  return { ids: cards.filter((c) => c.kind === "issue").map((c) => c.cardId), reviewId: cards.find((c) => c.kind === "review")!.cardId };
}

describe("the usefulness report (AC20)", () => {
  test("median of answer times", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  test("an empty ledger is an empty report", async () => {
    const report = await buildIntakeReport(env.root, () => new Date("2026-10-05T12:00:00Z"));
    expect(report).toEqual({ schema: 1, generatedAt: "2026-10-05T12:00:00.000Z", totalCards: 0, kinds: [], chains: [] });
    expect(formatIntakeReport(report)).toContain("карточек пока нет");
  });

  test("per kind: cards, decisions, the median time to answer and the share that matched the suggestion", async () => {
    const { ids, reviewId } = await setup();
    await decide(ids[0]!, "take", 60_000);
    await decide(ids[1]!, "decline", 120_000);
    await decide(ids[2]!, "take", 300_000);
    await decide(reviewId, "skip", 30_000);
    const report = await buildIntakeReport(env.root);
    expect(report.totalCards).toBe(4);
    const issue = report.kinds.find((k) => k.kind === "issue")!;
    expect(issue.cards).toBe(3);
    expect(issue.decisions).toEqual({ take: 2, decline: 1 });
    expect(issue.medianAnswerMs).toBe(120_000);
    expect(issue.decidedWithSuggestion).toBe(3);
    expect(issue.matchedSuggestion).toBeCloseTo(2 / 3, 5);
    const review = report.kinds.find((k) => k.kind === "review")!;
    expect(review.decisions).toEqual({ skip: 1 });
    expect(review.medianAnswerMs).toBe(30_000);
    expect(review.matchedSuggestion).toBeNull();
    const text = formatIntakeReport(report);
    expect(text).toContain("issue [take/decline/later]: карточек 3; решения: take 2, decline 1; медиана ответа 2 мин; совпало с подсказкой 67% (из 3)");
    expect(text).toContain("review [review-flow/skip]");
  });

  test("a card nobody answered has no decision and does not move the median", async () => {
    const { ids } = await setup();
    await decide(ids[0]!, "take", 60_000);
    const issue = (await buildIntakeReport(env.root)).kinds.find((k) => k.kind === "issue")!;
    expect(issue.cards).toBe(3);
    expect(issue.decisions).toEqual({ take: 1 });
    expect(issue.medianAnswerMs).toBe(60_000);
  });

  test("the card to flow to PR chain reads the flow's recorded pull request", async () => {
    const { ids } = await setup();
    await decide(ids[0]!, "take", 60_000, { flowId: "7", state: "taken" });
    await decide(ids[1]!, "take", 60_000, { flowId: "8", state: "taken" });
    await decide(ids[2]!, "take", 60_000, { flowId: "99", state: "taken" });
    const flows = path.join(env.root, ".metaproject", "flows");
    await mkdir(path.join(flows, "7-2026-10-05-first"), { recursive: true });
    await writeFile(path.join(flows, "7-2026-10-05-first", "flow.json"), JSON.stringify({ pr: { url: "https://github.com/MrCipherSmith/keryx/pull/901" } }), "utf8");
    await mkdir(path.join(flows, "8-2026-10-05-second"), { recursive: true });
    await writeFile(path.join(flows, "8-2026-10-05-second", "flow.json"), JSON.stringify({ pr: null }), "utf8");
    const report = await buildIntakeReport(env.root);
    expect(report.chains.map((c) => [c.flowId, c.pr])).toEqual([
      ["7", "https://github.com/MrCipherSmith/keryx/pull/901"],
      ["8", null],
      ["99", null],
    ]);
    expect(formatIntakeReport(report)).toContain("flow 7 → https://github.com/MrCipherSmith/keryx/pull/901");
    expect(formatIntakeReport(report)).toContain("flow 8 → PR ещё нет");
  });

  test("no title, body or assessment is in the report, its text, or the ledger", async () => {
    const { ids, reviewId } = await setup();
    await decide(ids[0]!, "take", 60_000, { flowId: "7", state: "taken" });
    await decide(reviewId, "skip", 1000);
    const report = await buildIntakeReport(env.root);
    const everything = `${JSON.stringify(report)}\n${formatIntakeReport(report)}\n${await readFile(intakeLedgerPath(env.root), "utf8")}`;
    for (const secret of ["Secret title", "Secret body", "Secret review title", "assessment of", "Issue 1", "Body of issue"]) {
      expect(everything).not.toContain(secret);
    }
    expect(Object.keys(report).sort()).toEqual(["chains", "generatedAt", "kinds", "schema", "totalCards"]);
  });
});

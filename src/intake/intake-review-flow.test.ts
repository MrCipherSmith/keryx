// AC9 (flow 403): «Открыть ревью-flow» on a review request creates a flow `Review <repo>#<n>` with the pull request
// link in its description. Nothing is written to GitHub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard } from "./actions";
import { OTHER_REPO, PROJECT, makeFakes, seedCard } from "./intake-actions.test-helpers";
import { REPO, local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { readIntakeCardView } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

describe("review-flow (AC9)", () => {
  test("a flow `Review <repo>#<n>` is made in the project, with the PR link in its description", async () => {
    const card = await seedCard(env.root, { kind: "review", ref: "57" });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "review-flow", { decidedBy: "4242", now: local(11, 5), deps: fakes.deps });
    expect(result).toMatchObject({ ok: true, flowId: "412" });
    const call = fakes.flows.initCalls[0]!;
    expect(call.project).toBe(PROJECT);
    expect(call.input.title).toBe(`Review ${REPO}#57`);
    expect(call.input.issueUrl).toBeUndefined();
    expect(call.input.source).toBe(`${card.content.url} card ${card.id}`);
    expect(fakes.flows.flows[0]!.description).toEqual([`Pull request: ${card.content.url}`]);
    expect(fakes.flows.flows[0]!.journal[0]!.line).toContain("review-flow by telegram");
    expect(fakes.flows.flows[0]!.journal[0]!.line).not.toContain("4242");
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "taken", choice: "review-flow", flowId: "412" });
  });

  test("the status line of the edited card names the review flow", async () => {
    const card = await seedCard(env.root, { kind: "review" });
    const result = await decideIntakeCard(env.root, card.id, "review-flow", { decidedBy: "1", now: local(11, 5), deps: makeFakes().deps });
    expect(result.statusLine).toBe("🔍 ревью-flow 11:05, flow 412");
  });

  test("with no clone of the repository nothing is created and the card may be pressed again", async () => {
    const card = await seedCard(env.root, { kind: "review", repo: OTHER_REPO });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "review-flow", { decidedBy: "1", deps: fakes.deps });
    expect(result.ok).toBe(false);
    expect(fakes.flows.flows).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("failed");
  });

  test("«Пропустить» on the same kind creates nothing", async () => {
    const card = await seedCard(env.root, { kind: "review" });
    const fakes = makeFakes();
    await decideIntakeCard(env.root, card.id, "skip", { decidedBy: "1", deps: fakes.deps });
    expect(fakes.flows.initCalls).toEqual([]);
  });
});

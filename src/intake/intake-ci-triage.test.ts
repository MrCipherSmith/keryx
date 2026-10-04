// AC10 (flow 403): «Разобрать» runs the advisory ci-triage under a limit. The truncated, redacted result goes to the
// topic; nothing is created and nothing is written to GitHub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard } from "./actions";
import { FakePressHub, PROJECT, makeFakes, pressFor, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { createIntakePressHandler } from "./press";
import { readIntakeCardView } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("ci-triage (AC10)", () => {
  test("runs once for the card's run in the project, under a time and size limit, and creates no flow", async () => {
    const card = await seedCard(env.root, { kind: "ci", ref: "9001" });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "ci-triage", { decidedBy: "4242", now: local(10, 20), deps: fakes.deps });
    expect(result).toMatchObject({ ok: true, message: "Разбор готов" });
    expect(fakes.ci.calls).toHaveLength(1);
    expect(fakes.ci.calls[0]!.project).toBe(PROJECT);
    expect(fakes.ci.calls[0]!.input).toMatchObject({ repo: card.content.repo, runId: "9001" });
    expect(fakes.ci.calls[0]!.input.timeoutMs).toBeGreaterThan(0);
    expect(fakes.ci.calls[0]!.input.maxBytes).toBeGreaterThan(0);
    expect(fakes.flows.initCalls).toEqual([]);
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view).toMatchObject({ state: "decided", choice: "ci-triage" });
    expect(view.flowId).toBeUndefined();
  });

  test("the result is redacted and cut before it goes to the topic", async () => {
    const card = await seedCard(env.root, { kind: "ci" });
    const fakes = makeFakes();
    fakes.ci.result = { ok: true, output: `token ${SECRET}\n${"line of log\n".repeat(2000)}` };
    const result = await decideIntakeCard(env.root, card.id, "ci-triage", { decidedBy: "1", deps: fakes.deps });
    expect(result.detail).toBeDefined();
    expect(result.detail).not.toContain(SECRET);
    expect(result.detail!.length).toBeLessThanOrEqual(3000);
  });

  test("through the button the detail is sent to the topic as a code block, never as markup from the log", async () => {
    const card = await seedCard(env.root, { kind: "ci", title: "ignored" });
    const fakes = makeFakes();
    fakes.ci.result = { ok: true, output: "```\n**bold** [x](https://evil.example)\n```" };
    const hub = new FakePressHub();
    const handler = createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: fakes.deps, now: () => local(10, 20) });
    await handler(pressFor(card, "ci-triage"));
    expect(hub.sends).toHaveLength(1);
    const text = hub.sends[0]!.text;
    expect(text.startsWith("Разбор CI")).toBe(true);
    expect(text.match(/```/g)).toHaveLength(2);
    expect(hub.sends[0]!.keyboard).toBeUndefined();
    expect(hub.edits[0]!.text).toContain("🔎 разобран 10:20");
  });

  test("a failed or empty triage fails the card, leaves it pressable, and sends nothing", async () => {
    const card = await seedCard(env.root, { kind: "ci" });
    const fakes = makeFakes();
    fakes.ci.result = { ok: false, reason: "ci-triage timed out" };
    const hub = new FakePressHub();
    const handler = createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: fakes.deps });
    const reply = await handler(pressFor(card, "ci-triage"));
    expect(reply?.text).toContain("не вышло");
    expect(hub.sends).toEqual([]);
    expect(await readIntakeCardView(env.root, card.id)).toMatchObject({ state: "failed", reason: "ci-triage timed out" });
    fakes.ci.result = { ok: true, output: "retry worked" };
    expect((await decideIntakeCard(env.root, card.id, "ci-triage", { decidedBy: "1", deps: fakes.deps })).ok).toBe(true);
  });

  test("«Игнорировать» does not run the triage", async () => {
    const card = await seedCard(env.root, { kind: "ci" });
    const fakes = makeFakes();
    await decideIntakeCard(env.root, card.id, "ignore", { decidedBy: "1", deps: fakes.deps });
    expect(fakes.ci.calls).toEqual([]);
  });
});

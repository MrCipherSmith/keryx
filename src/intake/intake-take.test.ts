// AC6 (flow 403): «Взять в работу» creates a flow from the ticket through `keryx flow init --issue`, in the project
// that holds a clone of the repository. The flow stays in `initializing`, its criteria are not frozen, nothing is
// written to GitHub, and the journal says who took it, when, from which card and on whose suggestion.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decideIntakeCard } from "./actions";
import { FakePressHub, PROJECT, OWNER, makeFakes, pressFor, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { createIntakePressHandler } from "./press";
import { readIntakeCardView, readIntakeLedger } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

describe("take (AC6)", () => {
  test("the flow is made from the ticket URL in the matching project, with the card as its origin", async () => {
    const card = await seedCard(env.root, { suggestion: "take", assessment: "Small bug." });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: String(OWNER), now: local(10, 42), deps: fakes.deps });
    expect(result).toMatchObject({ ok: true, flowId: "412", message: "Взято в работу: flow 412" });
    expect(fakes.flows.initCalls).toHaveLength(1);
    const call = fakes.flows.initCalls[0]!;
    expect(call.project).toBe(PROJECT);
    expect(call.input.issueUrl).toBe(card.content.url);
    expect(call.input.title).toBeUndefined();
    expect(call.input.source).toBe(`${card.content.url} card ${card.id}`);
  });

  test("the journal line names who, when, which card and the suggestion", async () => {
    const card = await seedCard(env.root, { suggestion: "take" });
    const fakes = makeFakes();
    const now = local(10, 42);
    await decideIntakeCard(env.root, card.id, "take", { decidedBy: "4242", now, deps: fakes.deps });
    const flow = fakes.flows.flows[0]!;
    expect(flow.journal).toHaveLength(1);
    expect(flow.journal[0]!.at).toBe(now.toISOString());
    expect(flow.journal[0]!.line).toContain("take by telegram");
    // S9: the journal is committed with the project; a Telegram user id never goes into it.
    expect(flow.journal[0]!.line).not.toContain("4242");
    expect(flow.journal[0]!.line).toContain(`card ${card.id}`);
    expect(flow.journal[0]!.line).toContain("suggestion take");
    expect(flow.journal[0]!.line).toContain("agent-proposal");
    expect(flow.journal[0]!.line).toContain(card.content.url!);
  });

  test("the card ends `taken` with the flow id, who decided and the time to answer", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    await decideIntakeCard(env.root, card.id, "take", { decidedBy: "4242", now: local(10, 42), deps: fakes.deps });
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(view).toMatchObject({ state: "taken", choice: "take", flowId: "412", decidedBy: "4242" });
    expect(view.timeToAnswerMs).toBe(42 * 60_000);
    const states = (await readIntakeLedger(env.root)).filter((r) => r.cardId === card.id).map((r) => r.state);
    expect(states).toEqual(["queued", "sent", "taking", "taken"]);
  });

  test("the flow is only started: it is not told to freeze criteria, and no gh call is made", async () => {
    const log = path.join(env.aside, "gh-calls.log");
    writeFileSync(env.ghBin, `#!/bin/sh\necho "$@" >> ${log}\n`, { mode: 0o755 });
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${env.aside}${path.delimiter}${savedPath ?? ""}`;
    try {
      // Positive control: a `gh` looked up on this PATH IS the logging shim, so were the decision to start one, the
      // log below would exist. Nothing here spawns it; the decision path is also scanned for any way to reach gh.
      expect(Bun.which("gh", { PATH: process.env["PATH"] ?? "" })).toBe(env.ghBin);
      for (const file of ["actions.ts", "press.ts", "ports.ts"]) {
        const code = readFileSync(path.join(import.meta.dir, file), "utf8");
        expect(code).not.toMatch(/granted-tools|child_process|\brunGh\b|\bBun\.(spawn|\$)/);
      }
      const card = await seedCard(env.root);
      const fakes = makeFakes();
      await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", deps: fakes.deps });
      expect(fakes.flows.initCalls).toHaveLength(1);
      expect(Object.keys(fakes.flows.initCalls[0]!.input).sort()).toEqual(["issueUrl", "source"]);
      expect(existsSync(log)).toBe(false);
    } finally {
      process.env["PATH"] = savedPath;
    }
  });

  test("the press edits the card in place: the line says taken, the time and the flow, and the buttons are gone", async () => {
    const card = await seedCard(env.root);
    const fakes = makeFakes();
    const hub = new FakePressHub();
    const handler = createIntakePressHandler({ hub, roots: () => [env.root], actionDeps: fakes.deps, now: () => local(10, 42) });
    const reply = await handler(pressFor(card, "take"));
    expect(reply).toEqual({ text: "Взято в работу: flow 412", edited: true });
    expect(hub.edits).toHaveLength(1);
    expect(hub.edits[0]).toMatchObject({ messageId: card.messageId });
    expect(hub.edits[0]!.text).toContain("✅ взято 10:42, flow 412");
    expect(hub.edits[0]!.keyboard).toBeUndefined();
  });
});

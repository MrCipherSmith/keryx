// AC5 (flow 403): the buttons of a card per kind, with callback data that is short and carries no text, and no
// take button where taking is forbidden.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INTAKE_ACTION_LABELS, intakeCallbackData, intakeKeyboard, parseIntakeCallbackData } from "./card";
import { decideIntakeCard } from "./actions";
import { makeFakes, seedCard } from "./intake-actions.test-helpers";
import { local, setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { readIntakeCardView } from "./store";
import { INTAKE_ACTIONS, type IntakeCardView, type IntakeEventKind } from "./types";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
});
afterEach(async () => {
  await env.teardown();
});

const labelsOf = (view: IntakeCardView): string[] => intakeKeyboard(view).flat().map((b) => b.text);

const EXPECTED: Record<IntakeEventKind, string[]> = {
  issue: ["Взять в работу", "Отклонить", "Позже"],
  review: ["Открыть ревью-flow", "Пропустить"],
  ci: ["Разобрать", "Игнорировать"],
  comment: ["Понятно"],
  board: ["Понятно"],
};

describe("buttons per kind (AC5)", () => {
  test.each(Object.keys(EXPECTED) as IntakeEventKind[])("%s card offers exactly its own buttons", async (kind) => {
    const card = await seedCard(env.root, { kind });
    expect(labelsOf((await readIntakeCardView(env.root, card.id))!)).toEqual(EXPECTED[kind]);
  });

  test("a card the take button is forbidden on has no take button, and a take is refused anyway", async () => {
    const card = await seedCard(env.root, { account: "work", takeAllowed: false });
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(labelsOf(view)).toEqual(["Отклонить", "Позже"]);
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", now: local(10, 42), deps: fakes.deps });
    expect(result.ok).toBe(false);
    expect(fakes.flows.initCalls).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("sent");
  });

  test("the overflow card has no buttons", async () => {
    const card = await seedCard(env.root);
    const view = (await readIntakeCardView(env.root, card.id))!;
    expect(intakeKeyboard({ ...view, kind: "overflow", actions: [], collapsedIds: ["c1", "c2"] })).toEqual([]);
  });

  test("an action outside the card's kind is refused and changes nothing", async () => {
    const card = await seedCard(env.root, { kind: "review" });
    const fakes = makeFakes();
    const result = await decideIntakeCard(env.root, card.id, "take", { decidedBy: "1", now: local(10, 42), deps: fakes.deps });
    expect(result.ok).toBe(false);
    expect(fakes.flows.initCalls).toEqual([]);
    expect((await readIntakeCardView(env.root, card.id))!.state).toBe("sent");
  });
});

describe("callback data (AC5)", () => {
  test("every button is `in:<id>:<code>`, at most 64 bytes, with no url and no title", async () => {
    const card = await seedCard(env.root, { repo: "MrCipherSmith/keryx", title: "A very long title ".repeat(40), url: "https://github.com/MrCipherSmith/keryx/issues/1" });
    for (const kind of Object.keys(EXPECTED) as IntakeEventKind[]) {
      const view = { ...(await readIntakeCardView(env.root, card.id))!, kind, actions: [...INTAKE_ACTIONS] };
      for (const button of intakeKeyboard(view).flat()) {
        expect(button.callback_data).toMatch(/^in:[a-z0-9]+:[a-z]$/);
        expect(Buffer.byteLength(button.callback_data!, "utf8")).toBeLessThanOrEqual(64);
        expect(button.callback_data).not.toContain("http");
        expect(button.callback_data).not.toContain("keryx/");
      }
    }
  });

  test("every action has its own code and survives a round trip", () => {
    const codes = new Set<string>();
    for (const action of INTAKE_ACTIONS) {
      const data = intakeCallbackData("c0123456789a", action);
      codes.add(data);
      expect(parseIntakeCallbackData(data)).toEqual({ cardId: "c0123456789a", action });
      expect(INTAKE_ACTION_LABELS[action].length).toBeGreaterThan(0);
    }
    expect(codes.size).toBe(INTAKE_ACTIONS.length);
  });

  test.each(["", "in:", "in:c1", "in:c1:zz", "in:c1:!", "in:C1:t", "xx:c1:t", "in:c1:t:extra", "in:c1:ack"])("data %p is not a press", (data) => {
    expect(parseIntakeCallbackData(data)).toBeUndefined();
  });
});

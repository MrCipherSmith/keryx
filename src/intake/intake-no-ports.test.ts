// AC7/AC11 (flow 403): a decision that cannot reach its ports must not throw out of `decideIntakeCard` and must not
// leave the card in `taking`. Without ports installed (a surface that forgot to install them) take and review-flow are
// refused before the claim (the work-root rule cannot be applied without a project), ci-triage ends `failed`; either way
// the card can be pressed again once they are there.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideIntakeCard } from "./actions";
import { OWNER, makeFakes, seedCard } from "./intake-actions.test-helpers";
import { setupIntakeEnv, type IntakeTestEnv } from "./intake.test-helpers";
import { installIntakeDefaultPorts } from "./ports";
import { readIntakeCardView } from "./store";

let env: IntakeTestEnv;
beforeEach(async () => {
  env = await setupIntakeEnv();
  installIntakeDefaultPorts(undefined);
});
afterEach(async () => {
  installIntakeDefaultPorts(undefined);
  await env.teardown();
});

describe("a decision with no ports installed (S3)", () => {
  for (const [action, kind] of [
    ["take", "issue"],
    ["review-flow", "review"],
    ["ci-triage", "ci"],
  ] as const) {
    test(`${action} resolves with a refusal, the card is not left taking, and a repeat press works once ports exist`, async () => {
      const card = await seedCard(env.root, { kind });
      const first = await decideIntakeCard(env.root, card.id, action, { decidedBy: String(OWNER), deps: {} });
      expect(first.ok).toBe(false);
      expect(first.message.length).toBeGreaterThan(0);
      expect((await readIntakeCardView(env.root, card.id))?.state).toBe(action === "ci-triage" ? "failed" : "sent");

      const fakes = makeFakes();
      const again = await decideIntakeCard(env.root, card.id, action, { decidedBy: String(OWNER), deps: fakes.deps });
      expect(again.ok).toBe(true);
      expect((await readIntakeCardView(env.root, card.id))?.state).not.toBe("failed");
    });
  }
});

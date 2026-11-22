import { expect, test } from "bun:test";
import { raceTelegramApproval } from "./telegram-approval";
import type { AcpClientRequestOutcome } from "./client-requests";
import type { PressedApproval } from "../remote/client";

const choices = [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" as const }, { optionId: "reject_once", name: "Reject", kind: "reject_once" as const }];
function setup() {
  let resolveDesktop!: (outcome: AcpClientRequestOutcome) => void;
  const desktop = new Promise<AcpClientRequestOutcome>((resolve) => { resolveDesktop = resolve; });
  let claim!: (answer: PressedApproval) => boolean;
  let projectionSignal!: AbortSignal;
  let cancelled = 0;
  const turn = new AbortController();
  let current = true;
  const result = raceTelegramApproval({ desktop: () => desktop, cancelDesktop: () => { cancelled++; },
    project: (signal, accept) => { projectionSignal = signal; claim = accept; return true; },
    current: () => current, choices, turnSignal: turn.signal, timeoutMs: 1000 });
  return { result, resolveDesktop, claim: (answer: PressedApproval) => claim(answer), projectionSignal: () => projectionSignal, cancelled: () => cancelled, turn, stale: () => { current = false; } };
}

test("Telegram wins once and closes Desktop, invalid and late presses cannot win", async () => {
  const s = setup();
  expect(s.claim({ decision: "allow" })).toBe(false);
  expect(s.claim({ decision: "always", fromId: 42 })).toBe(false);
  expect(s.claim({ decision: "allow", fromId: 42 })).toBe(true);
  expect(s.claim({ decision: "deny", fromId: 42 })).toBe(false);
  expect(await s.result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  expect(s.cancelled()).toBe(1);
  expect(s.projectionSignal().aborted).toBe(false);
});

test("Desktop winner closes Telegram projection and stale answers fail", async () => {
  const s = setup();
  s.resolveDesktop({ kind: "result", result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
  expect(await s.result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  expect(s.projectionSignal().aborted).toBe(true);
  expect(s.claim({ decision: "allow", fromId: 42 })).toBe(false);
  const stale = setup();
  stale.stale();
  expect(stale.claim({ decision: "allow", fromId: 42 })).toBe(false);
  stale.turn.abort();
  expect(await stale.result).toBeUndefined();
});

test("turn cancellation settles both sides closed", async () => {
  const s = setup();
  s.turn.abort();
  expect(await s.result).toBeUndefined();
  expect(s.cancelled()).toBe(1);
  expect(s.claim({ decision: "allow", fromId: 42 })).toBe(false);
});

test("deadline expires the shared decision and refuses later callbacks", async () => {
  let claim!: (answer: PressedApproval) => boolean;
  let closed = 0;
  const result = raceTelegramApproval({ desktop: () => new Promise(() => {}), cancelDesktop: () => { closed++; },
    project: (_signal, accept) => { claim = accept; return true; }, current: () => true,
    choices, turnSignal: new AbortController().signal, timeoutMs: 1 });
  expect(await result).toBeUndefined();
  expect(claim({ decision: "allow", fromId: 42 })).toBe(false);
  expect(closed).toBe(1);
});

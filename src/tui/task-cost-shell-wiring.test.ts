// Flow 341 (AC3) — proves `launchTuiAgentShell` (`tui-shell.ts`) actually
// wires `recordTurnTaskCostBestEffort` into the real interactive turn
// dispatch: THIS turn's own tokens (not the session's cumulative counter),
// fired `void` after the turn has settled, never delaying the next prompt.
// Same source-text-audit idiom `turn-guard-shell-wiring.test.ts` uses for
// logic wired deep inside this un-launchable-headlessly function
// (`launchTuiAgentShell` declines at its first line without a controlling
// TTY). The record's real *contents* are proven by
// `tui-shell.test.ts`'s "flow 341" behavioral test; this file proves the
// shell calls it at all, with the right inputs, at the right time.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
const FN_START = SOURCE.indexOf("export async function launchTuiAgentShell(opts: {");

test("launchTuiAgentShell exists and this audit is anchored inside it", () => {
  expect(FN_START).toBeGreaterThan(-1);
});

test("io.onUsage is wrapped to sum THIS turn's own tokens, exactly once per dispatch, before runAgentTurn is called", () => {
  const wrapAt = SOURCE.indexOf("const prevOnUsageForCost = io.onUsage;", FN_START);
  expect(wrapAt).toBeGreaterThan(FN_START);
  const dispatchAt = SOURCE.indexOf("void runAgentTurn(foregroundIo, deps, history, line, {", FN_START);
  expect(dispatchAt).toBeGreaterThan(wrapAt);
  const between = SOURCE.slice(wrapAt, dispatchAt);
  expect(between).toContain("turnInputTokens += usage.inputTokens ?? 0;");
  expect(between).toContain("turnOutputTokens += usage.outputTokens ?? 0;");
  expect(between).toContain("prevOnUsageForCost?.(usage);");
});

test("recordTurnTaskCostBestEffort is called inside the turn's .finally(), fired with `void` (never awaited by the settle callback)", () => {
  const finallyAt = SOURCE.indexOf("}).finally(() => {", FN_START);
  expect(finallyAt).toBeGreaterThan(FN_START);
  const callAt = SOURCE.indexOf("void recordTurnTaskCostBestEffort({", finallyAt);
  expect(callAt).toBeGreaterThan(finallyAt);
  const callEnd = SOURCE.indexOf("});", callAt);
  const call = SOURCE.slice(callAt, callEnd + "});".length);
  expect(call).toContain("providerId: deps.providerId,");
  expect(call).toContain("modelId: deps.modelId,");
  expect(call).toContain("inputTokens: turnInputTokens,");
  expect(call).toContain("outputTokens: turnOutputTokens,");
  expect(call).toContain("success: !turnFailed,");
  expect(call).toContain('...(turnCategory !== undefined ? { category: turnCategory } : {}),');
});

// PR #737's routing classifier wiring: `turnCategory` is captured ONCE, from
// `routingOutcome?.category`, UNCONDITIONALLY for the turn — after the
// routed-only branch closes (so a `session-default` resolution, not only an
// actual reroute, still sets it), and before the turn even dispatches.
test("turnCategory is captured unconditionally from routingOutcome?.category, outside the routed-only branch, before the turn dispatches", () => {
  const routingOutcomeDeclAt = SOURCE.indexOf("let routingOutcome: RoutingClassifierTurnResult | undefined;", FN_START);
  expect(routingOutcomeDeclAt).toBeGreaterThan(FN_START);

  const routedBranchAt = SOURCE.indexOf("if (routingOutcome?.routed !== undefined) {", routingOutcomeDeclAt);
  expect(routedBranchAt).toBeGreaterThan(routingOutcomeDeclAt);
  // The routed-only branch's own fail-closed catch — the last thing inside it.
  const routedBranchFailClosedAt = SOURCE.indexOf(
    "// fail-closed: a routed-deps build failure runs on the session's own model instead.",
    routedBranchAt,
  );
  expect(routedBranchFailClosedAt).toBeGreaterThan(routedBranchAt);

  const turnCategoryAt = SOURCE.indexOf(
    "const turnCategory: RoutingCategory | undefined = routingOutcome?.category;",
    FN_START,
  );
  // Declared AFTER the routed-only branch closes — unconditional, not nested inside it.
  expect(turnCategoryAt).toBeGreaterThan(routedBranchFailClosedAt);

  const dispatchAt = SOURCE.indexOf("void runAgentTurn(foregroundIo, deps, history, line, {", FN_START);
  expect(dispatchAt).toBeGreaterThan(turnCategoryAt);
});

test("the record call runs AFTER setMainAgent has already read turnFailed for this turn (ordering: outcome computed, THEN recorded)", () => {
  const setMainAgentAt = SOURCE.indexOf('setMainAgent(turnFailed ? "failed" : "done"', FN_START);
  expect(setMainAgentAt).toBeGreaterThan(FN_START);
  const callAt = SOURCE.indexOf("void recordTurnTaskCostBestEffort({", FN_START);
  expect(callAt).toBeGreaterThan(setMainAgentAt);
});

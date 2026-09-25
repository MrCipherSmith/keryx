// Flow 329 (AC2/AC4): the turn guard's wiring inside `launchTuiAgentShell`
// (`tui-shell.ts`) — that it collects the CURRENT turn only, is fired
// `void` (never awaited) after the turn has already settled, and prints the
// notice only when the verdict is flagged. Same source-text-audit idiom
// `provider-catalog-startup.test.ts` and `tui-shell.test.ts`'s own "SLATE-3a"/
// "SLATE-2a" audits use for logic wired deep inside this un-launchable-
// headlessly function (`launchTuiAgentShell` declines at its first line
// without a controlling TTY, so it is never invoked directly here). The
// hanging-Jev half of the non-blocking guarantee is proven at the module
// level in `turn-guard-source.test.ts`; this test proves the SHELL wires
// that module the way the guarantee assumes.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
const FN_START = SOURCE.indexOf("export async function launchTuiAgentShell(opts: {");

test("launchTuiAgentShell exists and this audit is anchored inside it", () => {
  expect(FN_START).toBeGreaterThan(-1);
});

test("the tool-call/result/assistant-text collector hooks are wrapped exactly ONCE (permanent, not re-wrapped per turn)", () => {
  const onToolCallWrap = "io.onToolCall = (name, toolInput) => {\n      guardCollector.onToolCall(name, toolInput);";
  const onToolResultWrap = "io.onToolResult = (name, toolResult) => {\n      guardCollector.onToolResult(name, toolResult);";
  const onAssistantTextWrap = "io.onAssistantText = (text) => {\n      guardCollector.onAssistantText(text);";
  expect(SOURCE.split(onToolCallWrap)).toHaveLength(2); // exactly one occurrence
  expect(SOURCE.split(onToolResultWrap)).toHaveLength(2);
  expect(SOURCE.split(onAssistantTextWrap)).toHaveLength(2);
});

test("guardCollector.reset(line) runs BEFORE runAgentTurn is dispatched for that same line", () => {
  const resetAt = SOURCE.indexOf("guardCollector.reset(line);", FN_START);
  expect(resetAt).toBeGreaterThan(FN_START);
  const dispatchAt = SOURCE.indexOf("void runAgentTurn(foregroundIo, deps, history, line, {", FN_START);
  expect(dispatchAt).toBeGreaterThan(resetAt);
});

test("AC2: the guard run is fired with `void` inside the turn's .finally() — never awaited, so it cannot delay the next prompt", () => {
  const finallyAt = SOURCE.indexOf("}).finally(() => {", FN_START);
  expect(finallyAt).toBeGreaterThan(FN_START);
  const finallyEndAt = SOURCE.indexOf("\n      });\n", finallyAt); // the runAgentTurn(...).finally(() => { ... }) call's own close
  const finallyBody = SOURCE.slice(finallyAt, finallyEndAt > finallyAt ? finallyEndAt : SOURCE.length);
  expect(finallyBody).toContain("if (guardEnabled) {");
  const voidCallAt = finallyBody.indexOf("void (async () => {");
  expect(voidCallAt).toBeGreaterThan(-1);
  expect(finallyBody).toContain("const guardResult = await runTurnGuard(guardTranscript, { enabled: guardEnabled });");
  // Never `await`ed by the (synchronous) .finally() callback itself.
  const finallyCallbackParamsEnd = finallyBody.indexOf(") => {") + ") => {".length;
  expect(finallyBody.slice(0, finallyCallbackParamsEnd)).not.toContain("async");
});

test("the notice prints only inside an `if (guardResult.verdict.flagged)` guard", () => {
  const noticeAt = SOURCE.indexOf("renderTurnGuardNoticeLine(guardResult.verdict)", FN_START);
  expect(noticeAt).toBeGreaterThan(FN_START);
  const before = SOURCE.slice(Math.max(0, noticeAt - 200), noticeAt);
  expect(before).toContain("if (guardResult.verdict.flagged) {");
});

test("a flagged/unflagged result is always recorded into guard history (for the /guard modal), regardless of the notice", () => {
  const recordAt = SOURCE.indexOf("recordGuardResult(guardResult);", FN_START);
  expect(recordAt).toBeGreaterThan(FN_START);
  const noticeAt = SOURCE.indexOf("renderTurnGuardNoticeLine(guardResult.verdict)", FN_START);
  // recordGuardResult runs BEFORE the flagged check — every turn's result is
  // kept, not only the flagged ones.
  expect(recordAt).toBeLessThan(noticeAt);
});

test("AC5: /guard's on/off toggle persists to ShellConfig.turnGuard.enabled and refreshes the sidebar", () => {
  const setAt = SOURCE.indexOf("const setGuardEnabled = (next: boolean): void => {", FN_START);
  expect(setAt).toBeGreaterThan(FN_START);
  const body = SOURCE.slice(setAt, SOURCE.indexOf("};", setAt));
  expect(body).toContain("saveShellConfig({ turnGuard: { enabled: next } });");
  expect(body).toContain("refreshGuardSidebar();");
});

test("AC5: --guard (initialGuardEnabled) falls back to the persisted ShellConfig setting when the flag is absent", () => {
  const declAt = SOURCE.indexOf(
    "let guardEnabled = opts.initialGuardEnabled ?? loadShellConfig().turnGuard?.enabled === true;",
    FN_START,
  );
  expect(declAt).toBeGreaterThan(FN_START);
});

// PR #720 review item 2: `runTurnGuard` awaits an up-to-8s Jev round trip —
// by the time it resolves, the renderer may be gone or this turn's own
// operation cancelled. The guard's deferred continuation must check that,
// the same idiom the other deferred continuations in this function use right
// after their own `await` (`foregroundOperation.signal.aborted ||
// foregroundOperation.isDisposed`), BEFORE touching guard history, the
// sidebar, or the system line.
test("`turnSignal` is captured from `foregroundOperation.signal` BEFORE `foregroundOperation.settle(operation)` runs", () => {
  const captureAt = SOURCE.indexOf("const turnSignal = foregroundOperation.signal;", FN_START);
  expect(captureAt).toBeGreaterThan(FN_START);
  // Search from `captureAt`, not `FN_START` — an EARLIER, unrelated
  // `foregroundOperation.settle(operation);` belongs to the wiki-enrich
  // pre-router's own (differently scoped) `operation` binding higher up in
  // this same function.
  const settleAt = SOURCE.indexOf("foregroundOperation.settle(operation);", captureAt);
  expect(settleAt).toBeGreaterThan(captureAt);
  // And it is what `runAgentTurn` is actually dispatched with (not a second,
  // unrelated read of the live signal).
  const dispatchAt = SOURCE.indexOf("void runAgentTurn(foregroundIo, deps, history, line, {", FN_START);
  const dispatchBlock = SOURCE.slice(dispatchAt, SOURCE.indexOf("}).finally(() => {", dispatchAt));
  expect(dispatchBlock).toContain("signal: turnSignal,");
});

test("the guard's deferred continuation checks `turnSignal.aborted || foregroundOperation.isDisposed` before recording/refreshing/printing", () => {
  const guardResultAt = SOURCE.indexOf("const guardResult = await runTurnGuard(guardTranscript, { enabled: guardEnabled });", FN_START);
  expect(guardResultAt).toBeGreaterThan(FN_START);
  const recordAt = SOURCE.indexOf("recordGuardResult(guardResult);", FN_START);
  const refreshAt = SOURCE.indexOf("refreshGuardSidebar();", recordAt);
  const onSystemAt = SOURCE.indexOf("io.onSystem?.(`${renderTurnGuardNoticeLine(guardResult.verdict)}\\n`);", FN_START);
  const guardAt = SOURCE.indexOf("if (turnSignal.aborted || foregroundOperation.isDisposed) return;", FN_START);
  expect(guardAt).toBeGreaterThan(guardResultAt);
  expect(guardAt).toBeLessThan(recordAt);
  expect(recordAt).toBeLessThan(refreshAt);
  expect(refreshAt).toBeLessThan(onSystemAt);
});

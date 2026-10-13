// Flow 338 (PR #737 review fix) — the routing classifier's wiring inside
// `launchTuiAgentShell` (`tui-shell.ts`): the `/route` toggle's persistence
// (merge-safety), routing independent of `/model`, and that a routed turn
// builds a FRESH `deps` object rather than mutating the session's own. Same
// source-text-audit idiom `turn-guard-shell-wiring.test.ts` uses for logic
// wired deep inside this un-launchable-headlessly function
// (`launchTuiAgentShell` declines at its first line without a controlling
// TTY, so it is never invoked directly here).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
const FN_START = SOURCE.indexOf("export async function launchTuiAgentShell(opts: {");

test("launchTuiAgentShell exists and this audit is anchored inside it", () => {
  expect(FN_START).toBeGreaterThan(-1);
});

test("/route's on/off toggle read-and-spreads the existing ShellConfig.routingClassifier value before persisting, so a future second field (classifier: \"jev\") is never silently dropped", () => {
  const setAt = SOURCE.indexOf("const setRoutingEnabled = (next: boolean): void => {", FN_START);
  expect(setAt).toBeGreaterThan(FN_START);
  const body = SOURCE.slice(setAt, SOURCE.indexOf("\n    };", setAt));
  // NOT the bare-overwrite shape `setGuardEnabled` gets away with (its own
  // `turnGuard` carries only `enabled`) — `routingClassifier` already
  // declares a second field (`ShellConfig.routingClassifier.classifier`,
  // `src/lib/shell-config.ts`), so this call site must read the existing
  // value first and spread it in (`saveProviderBaseUrl`'s own idiom).
  expect(body).not.toContain("saveShellConfig({ routingClassifier: { enabled: next } });");
  expect(body).toContain("const existing = loadShellConfig().routingClassifier ?? {};");
  expect(body).toContain("saveShellConfig({ routingClassifier: { ...existing, enabled: next } });");
  expect(body).toContain("refreshRoutingSidebar();");
});

test("a turn routes when routing is on, the turn is the operator's own, and the line is non-empty regardless of /model", () => {
  const gateAt = SOURCE.indexOf(
    'if (routingEnabled && origin === "operator" && line.trim().length > 0) {',
    FN_START,
  );
  expect(gateAt).toBeGreaterThan(FN_START);
});

test("an explicit /model or /connect pick changes the baseline without pinning routing off", () => {
  const switchToAt = SOURCE.indexOf("const switchTo = async (ns: TuiSelection): Promise<void> => {", FN_START);
  expect(switchToAt).toBeGreaterThan(FN_START);
  const nextConstAt = SOURCE.indexOf("const switchTo", switchToAt + 1) > -1 ? SOURCE.indexOf("const switchTo", switchToAt + 1) : SOURCE.length;
  const body = SOURCE.slice(switchToAt, Math.min(switchToAt + 2000, nextConstAt));
  expect(body).toContain("currentSel = ns;");
  expect(body).not.toContain("routingEnabled = false");
  expect(SOURCE).not.toContain("sessionModelExplicit");
  expect(SOURCE).not.toContain("manual /model selection pins this session");
});

test("a routed turn's deps are a FRESH object from a fresh makeAgentDeps call — the routed IIFE reassigns its own block-scoped `deps`, never `sessionDeps` (the outer session's own reference)", () => {
  const gateAt = SOURCE.indexOf(
    'if (routingEnabled && origin === "operator" && line.trim().length > 0) {',
    FN_START,
  );
  expect(gateAt).toBeGreaterThan(FN_START);
  const blockEnd = SOURCE.indexOf("\n        // flow 329: starts collecting THIS turn's tool calls", gateAt);
  expect(blockEnd).toBeGreaterThan(gateAt);
  const body = SOURCE.slice(gateAt, blockEnd);
  // A brand-new deps object — spreads a FRESH `opts.makeAgentDeps(...)` call
  // result, never spreads/mutates `sessionDeps` itself.
  expect(body).toContain(
    "deps = {\n                ...(await opts.makeAgentDeps({ provider: routingOutcome.routed.providerId, model: routingOutcome.routed.modelId }, liveSlateSession, busClientRef)),",
  );
  // The fail-closed catch falls back to the SESSION's own deps (by
  // reference, read-only) — it never writes INTO `sessionDeps`.
  expect(body).toContain("deps = sessionDeps;");
  expect(body).not.toContain("sessionDeps.provider =");
  expect(body).not.toContain("sessionDeps.model =");
  expect(body).not.toContain("Object.assign(sessionDeps");
});


test("flow411: captured turn signal cancels classification and gates executor dispatch", () => {
  const start = SOURCE.indexOf("const turnSignal = foregroundOperation.signal;", FN_START);
  const end = SOURCE.indexOf("const accepted = settleForegroundOperation(foregroundOperation, operation);", start);
  expect(start).toBeGreaterThan(FN_START);
  expect(end).toBeGreaterThan(start);
  const body = SOURCE.slice(start, end);
  expect(body).toContain("signal: turnSignal,");
  expect(body).toContain("if (!turnSignal.aborted && routingOutcome?.routed !== undefined)");
  expect(body).toContain("turnSignal.aborted ? Promise.resolve() : runAgentTurn(");
  // Headless source audit only: the behavioral chain is exercised separately.
});


test("flow411: cancellation after routed preparation suppresses success and fallback diagnostics", () => {
  const start = SOURCE.indexOf("// Preparation can settle after cancellation", FN_START);
  expect(start).toBeGreaterThan(FN_START);
  const end = SOURCE.indexOf("// Flow 341", start);
  const body = SOURCE.slice(start, end);
  expect(body).toContain("if (!turnSignal.aborted) {\n                routingRoutedCount += 1;");
  expect(body).toContain('if (!turnSignal.aborted) io.onSystem?.("[route fallback: selected model');
  expect(body).toContain("} else if (!turnSignal.aborted) {");
});


test("routing dispatch and picker share their catalog loader", () => {
  const start = SOURCE.indexOf('if (routingEnabled && origin === "operator" && line.trim().length > 0) {', FN_START);
  expect(SOURCE.slice(start, SOURCE.indexOf("// Flow 341", start))).toContain("providers: loadRoutingProviders,");
  expect(readFileSync(join(import.meta.dir, "routing-inspector.ts"), "utf8")).toContain("options.providers ?? loadRoutingProviders");
});

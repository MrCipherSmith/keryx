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
const ROUTING_SOURCE = readFileSync(join(import.meta.dir, "routing-classifier-source.ts"), "utf8");
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
  // Merged into the value on disk at write time: a pre-read `existing` spread
  // through `saveShellConfig` reverted `enabled` after a concurrent change.
  expect(body).not.toContain("loadShellConfig()");
  expect(body).not.toContain("saveShellConfig(");
  expect(body).toContain(
    "updateShellConfig((current) => ({ ...current, routingClassifier: { ...(current.routingClassifier ?? {}), enabled: next } }));",
  );
  expect(body).toContain("refreshRoutingSidebar();");
});

test("a turn routes when routing is on, the turn is the operator's own, and the line is non-empty regardless of /model", () => {
  const gateAt = SOURCE.indexOf(
    'if (routingEnabled && origin === "operator" && !agentShaped && line.trim().length > 0) {',
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
    'if (routingEnabled && origin === "operator" && !agentShaped && line.trim().length > 0) {',
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
  expect(body).toContain("routingOutcome?.blockTurn === true");
  expect(body).toContain("foregroundOperation.settle(operation)");
  expect(body).toContain("else if (!turnSignal.aborted && routingOutcome?.routed !== undefined)");
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


test("routing dispatch and picker share their catalog loader, both handed the shell's redetect", () => {
  // Flow 468: per-turn dispatch and the `/routing` picker load the same catalog through `loadRoutingProviders`, each with the shell's live detection.
  const start = SOURCE.indexOf('if (routingEnabled && origin === "operator" && !agentShaped && line.trim().length > 0) {', FN_START);
  expect(SOURCE.slice(start, SOURCE.indexOf("// Flow 341", start))).toContain("providers: () => loadRoutingProviders(opts.redetect),");
  expect(readFileSync(join(import.meta.dir, "routing-inspector.ts"), "utf8")).toContain("options.providers ?? (() => loadRoutingProviders(options.redetect");
  const showRoutingAt = SOURCE.indexOf("openRouting(otui, chrome, {", FN_START);
  expect(showRoutingAt).toBeGreaterThan(FN_START);
  expect(SOURCE.slice(showRoutingAt, showRoutingAt + 1200)).toContain("redetect: opts.redetect");
});

test("routing receives the frozen real turn envelope and proven baseline capabilities", () => {
  const start = SOURCE.indexOf('if (routingEnabled && origin === "operator" && !agentShaped && line.trim().length > 0) {', FN_START);
  const body = SOURCE.slice(start, SOURCE.indexOf("// Flow 341", start));
  expect(body).toContain("requestId: sessionDeps.idSeq()");
  expect(body).toContain("inputTokensRequired: estimateRequestTokens(");
  expect(body).toContain("sessionDeps.tools.map((tool) => tool.definition)");
  expect(body).toContain('capabilities: sessionDeps.tools.length > 0 ? ["tools"] : []');
  expect(body).toContain("outputTokensReserved: sessionDeps.maxOutputTokens ?? resolveAgentMaxOutputTokens()");
  expect(body).toContain("baselineCapabilities");
  expect(body).toContain("describeProvider: opts.describeProvider");
});

test("there is no shadow or legacy engine: every enabled turn resolves through the one routing turn service", () => {
  expect(ROUTING_SOURCE).not.toContain("KERYX_ROUTING_V2_SHADOW");
  expect(ROUTING_SOURCE).not.toContain("classifyTurn(");
  const entry = ROUTING_SOURCE.slice(ROUTING_SOURCE.indexOf("export async function runRoutingClassifierForTurn("));
  expect(entry).toContain("if (!opts.enabled) return undefined;");
  expect(entry).toContain("return await runRoutingForTurn(");
});

test("TUI routing wraps the authorized fixed target with the classifier's shared budget and receipt", () => {
  const start = SOURCE.indexOf("const routingExecution = routingOutcome.routingExecution;", FN_START);
  const end = SOURCE.indexOf("// Flow 341", start);
  const body = SOURCE.slice(start, end);
  expect(start).toBeGreaterThan(FN_START);
  expect(body).toContain("createMeteredRoutingProvider({");
  expect(body).toContain("receipt: prepared.receipt");
  expect(body).toContain("budget: routingExecution.budget");
  expect(body).toContain("beforeIo: routingExecution.beforeIo");
  expect(body.match(/selectionTimeoutMs: Math\.max\(0, routingExecution\.selectionDeadline - performance\.now\(\)\)/g)).toHaveLength(2);
  expect(body).toContain("routingExecution.estimatedCostUsd(request, prepared.target)");
  expect(body).toContain("routingExecution.actualCostUsd(");
  expect(body).toContain("value.providerId !== target.providerId");
  expect(ROUTING_SOURCE).not.toContain("finite routing budget cannot be enforced by the TUI agent-loop boundary");
});

test("TUI consumes the neutral routing turn service and supplies trusted capability and cost ports", () => {
  const start = ROUTING_SOURCE.indexOf("async function runRoutingForTurn(");
  const end = ROUTING_SOURCE.indexOf("export async function runRoutingClassifierForTurn(", start);
  const active = ROUTING_SOURCE.slice(start, end);
  expect(active).toContain("routeTurn({");
  expect(active).toContain("capabilityFacts.get(profileKey(target.providerId, target.modelId)) ?? []");
  expect(active).toContain("estimatedCostUsd: (adapter) => classifierCost(adapter.id)");
  expect(active).toContain("actualCostUsd: classifierActualCost");
  expect(active).not.toContain("estimatedCostUsd: () => null");
});

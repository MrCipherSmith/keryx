import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalDigest } from "../src/remote-control/protocol";
import { buildNativeCoverageDescriptor, checkNativeCommandCoverage, currentNativeCoverageSubject, receiptParity, registeredNativeCommandNames, type NativeCoverageDescriptor, type NativeNormalizedOutcome } from "../src/session/commands/coverage";
import { checkEmbeddedDescriptor, collectParityRun, DESCRIPTOR_PATH, INVENTORY_PATH, judgeNativeCoverage, readInventory, receiptsFor, sourceHashes } from "./verify-native-coverage";
import { detectSandboxLauncher } from "../src/harness/process/sandbox/detect";

const root = resolve(import.meta.dir, "..");
/**
 * The parity variants that run a live owned turn (approvals, questions, interrupt, the full inventory) run under a profile
 * whose isolation is required-fail-closed, so the built-in gate hooks stay sandboxed: on a host without the platform
 * launcher (sandbox-exec on macOS, bwrap on Linux) `keryx.security-check-input` refuses every such turn before the
 * provider. Those tests skip only where the launcher is absent; the macOS real-host CI job runs this file with zero skips.
 */
const launcher = detectSandboxLauncher();
const needsSandbox = launcher.available ? "" : ` (skipped: live turns need the OS sandbox launcher; ${launcher.reason})`;
async function embedded(): Promise<NativeCoverageDescriptor> {
  return (await import("../src/session/native-coverage.generated")).NATIVE_COVERAGE_DESCRIPTOR as NativeCoverageDescriptor;
}

test.skipIf(!launcher.available)(`receipts come from executing the same variant through the real terminal adapter and headless host, and expose failing parity${needsSandbox}`, async () => {
  const inventory = await readInventory(root);
  const run = await collectParityRun(root, inventory, ["status.default", "reasoning.high", "reasoning.off", "trail.tool-NAME", "intake.list", "interrupt.default", "model.select", "history.N-1-20",
    "tasks.kill", "demote.task-id", "flows.list", "flows.detail", "rewind.picker", "approvals.allow-once", "status.questions-answer", "goal.-workspace", "queue.remove-N", "queue.force-N"]);
  const receipts = receiptsFor(inventory, run, await sourceHashes(root, inventory));
  const parity = Object.fromEntries(receipts.map((receipt) => [receipt.variantId, { ...receiptParity(receipt), receipt }]));
  expect(parity["status.default"]).toMatchObject({ matched: true, admitted: true, receipt: { local: { line: "/status", outcome: { status: "applied" } }, headless: { arguments: {}, outcome: { status: "applied" } } } });
  // A real live owned turn is interrupted through both paths.
  expect(parity["interrupt.default"]).toMatchObject({ matched: true, admitted: true });
  // A metered effort change needs the same human confirmation on both paths.
  expect(parity["reasoning.high"]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "confirmation-required" } } } });
  // The terminal adapter maps `/reasoning off` to the typed `none`, a typed TUI argument and a subcommand to its dotted handler.
  for (const id of ["reasoning.off", "trail.tool-NAME", "intake.list"]) expect({ id, ...receiptParity(parity[id]!.receipt) }).toEqual({ id, matched: true, admitted: true });
  // The picker-only `/model` has the terminal text form `/model <candidateId>`: the same idle-boundary selection on both paths.
  expect(parity["model.select"]).toMatchObject({ matched: true, admitted: true, receipt: { local: { line: "/model local-candidate", outcome: { status: "applied" } } } });
  // Real owners: a supervised session shell task, the Hub's scoped Flow reader, the owned-checkout rewind port.
  for (const id of ["tasks.kill", "demote.task-id", "flows.list", "flows.detail", "rewind.picker"]) expect({ id, ...receiptParity(parity[id]!.receipt) }).toEqual({ id, matched: true, admitted: true });
  // A real approval waiter and a real ask_user question: the terminal names the card by id and resolves its pins from the session's own pending list.
  for (const id of ["approvals.allow-once", "status.questions-answer"]) expect(parity[id]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "applied" } } } });
  // `/history N` reads the last N messages through the same typed history read.
  expect(parity["history.N-1-20"]).toMatchObject({ matched: true, admitted: true, receipt: { headless: { arguments: { count: 5 } } } });
  // A workspace-class goal runs as one new local run under the operator's explicit work mode, admitted on both paths.
  expect(parity["goal.-workspace"]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "queued" } } } });
  // `/queue remove N` is the frozen QueueRemove operation on the qN item; `/queue force` has no typed native form and stays a gap.
  expect(parity["queue.remove-N"]).toMatchObject({ matched: true, admitted: true, receipt: { headless: { operation: "remove-queue" } } });
  expect(parity["queue.force-N"]).toMatchObject({ matched: false, receipt: { local: { outcome: { errorCode: "invalid-arguments" } }, headless: { arguments: null, outcome: null } } });
  for (const receipt of receipts) expect(receipt.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
}, 120_000);

test("lifecycle variants run bridge-hosted: both paths reach a real enrolled MachineBridge only through Hub v2, and outcomes are the final operation receipts", async () => {
  const inventory = await readInventory(root);
  const lifecycle = ["new.default", "clear.default", "resume.picker", "sessions.picker", "sessions.open", "sessions.resume", "sessions.fork"];
  const run = await collectParityRun(root, inventory, ["status.default", ...lifecycle]);
  const receipts = receiptsFor(inventory, run, await sourceHashes(root, inventory));
  const parity = Object.fromEntries(receipts.map((receipt) => [receipt.variantId, { ...receiptParity(receipt), receipt }]));
  // The subject is the machine-hosted catalogue: the bridge's authenticated lifecycle port is advertised, and the non-bridge hosts agree on it.
  for (const name of ["new", "clear", "resume", "sessions", "sessions.open", "sessions.resume", "sessions.fork"]) expect(run.catalogue.entries.find((entry) => entry.commandName === name)).toMatchObject({ availability: "available", reason: "authenticated-machine-lifecycle-port" });
  expect(parity["status.default"]).toMatchObject({ matched: true, admitted: true });
  // Hub first answers pending/queued; the receipt holds the machine's final applied outcome on both paths.
  for (const id of ["new.default", "clear.default"]) expect(parity[id]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "applied", errorCode: null } }, headless: { outcome: { status: "applied", errorCode: null } } } });
  for (const id of ["resume.picker", "sessions.picker"]) expect(parity[id]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "applied" } }, headless: { arguments: {}, outcome: { status: "applied" } } } });
  // The typed selection forms apply through the Hub against real prior sessions and a second mapped checkout, from the terminal text form
  // (`/sessions open|resume <id>`, `/sessions fork <checkout> <title>`) as from the typed request: every pin is read fresh from Hub.
  expect(parity["sessions.fork"]).toMatchObject({ receipt: { local: { line: "/sessions fork checkout-2 Fork" } } });
  for (const id of ["sessions.open", "sessions.resume", "sessions.fork"]) expect(parity[id]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "applied", errorCode: null } }, headless: { outcome: { status: "applied", errorCode: null } } } });
}, 180_000);

test.skipIf(!launcher.available)(`release guard re-executes the committed inventory: the embedded descriptor is current and release-ready, and a gap or stale/tampered/missing evidence fails closed${needsSandbox}`, async () => {
  const inventory = await readInventory(root);
  const hashes = await sourceHashes(root, inventory);
  const run = await collectParityRun(root, inventory);
  const verification = await judgeNativeCoverage(root, inventory, run, hashes, false);
  const descriptor = await embedded();
  expect(checkEmbeddedDescriptor(verification, descriptor, false)).toMatchObject({ ok: true });
  // Every required variant earned its receipt, so the release guard admits the embedded descriptor.
  expect(checkEmbeddedDescriptor(verification, descriptor, true)).toMatchObject({ ok: true });
  const gaps = descriptor.requiredGaps.map((gap) => gap.variantId);
  expect(gaps).toEqual([]);
  // Cited spec-3.1 boundaries, neither earned nor a hidden gap: Telegram remote control (owner decision 2026-10-28), Jev analysis without local
  // Jev setup and consent, queue actions no frozen queue operation expresses (owner decision 2026-10-29), and the stage-4 decisions:
  // the conform wizard steps, running a trigger, the TUI-memory guard details and a GitHub CI run detail (ownerDecisionStage4).
  for (const id of ["remote-control.on", "remote-control.name", "remote-control.off", "remote-control.status", "risk.working-diff", "conform.run", "ci.retry", "triage.latest-review", "queue.force", "queue.force-N", "queue.edit",
    "conform.reference-select", "conform.target-diff", "conform.target-pr", "conform.target-report", "conform.clause-detail", "triggers.run", "triggers.confirm-run", "guard.measured-details", "ci.detail"]) { expect(descriptor.boundaries).toContain(id); expect(descriptor.earned).not.toContain(id); }
  expect(descriptor.releaseReady).toBe(true);
  // A required variant without its receipt is a visible gap, and the release guard refuses a descriptor that carries one.
  const gapRun = { ...run, outcomes: run.outcomes.filter((outcome) => outcome.variantId !== "ac.check") };
  const refreshed = (await judgeNativeCoverage(root, inventory, gapRun, hashes, true)).refreshed;
  const withGap = await judgeNativeCoverage(root, refreshed, gapRun, hashes, false);
  expect([withGap.descriptor.releaseReady, withGap.descriptor.requiredGaps.map((gap) => gap.variantId)]).toEqual([false, ["ac.check"]]);
  expect(checkEmbeddedDescriptor(withGap, withGap.descriptor, false)).toMatchObject({ ok: true });
  expect(checkEmbeddedDescriptor(withGap, withGap.descriptor, true)).toEqual({ ok: false, code: "not-release-ready" });
  expect(descriptor.earned).toEqual(expect.arrayContaining(["status.default", "help.default", "interrupt.default", "settings.read", "tasks.kill", "demote.task-id", "flows.list", "ac.cached", "rewind.picker", "mcp.status", "bus.modal", "mode.show",
    "model.select", "connect.select", "connect.test", "autoreview.start", "autoreview.stop", "bus.send", "goal.-workspace", "approvals.allow-once", "queue.remove-N", "reasoning.show",
    "new.default", "clear.default", "resume.picker", "sessions.picker", "sessions.open", "sessions.resume", "sessions.fork", "compact.focus", "mode.ask",
    "search-connect.select", "projectctx.warn", "projectctx.block", "flow.origin-summary", "flow.origin-set-reason", "flow.origin-set-reason-quote-source", "workspace.slate-detail", "routing.category-assignments",
    "ac.check", "flows.ac-check", "decisions.reason", "decisions.change"]));
  // A lifecycle receipt binds the bridge and Hub lifecycle sources it ran through: a changed bridge makes it stale.
  const bridgeStale = structuredClone(inventory);
  const created = bridgeStale.commands.find((command) => command.commandName === "new")!;
  const pin = created.sources.findIndex((source) => source.path === "src/lib/hub-machine/bridge.ts");
  expect(pin).toBeGreaterThanOrEqual(0);
  created.sources[pin] = { ...created.sources[pin]!, sha256: "0".repeat(64) };
  expect((await judgeNativeCoverage(root, bridgeStale, run, hashes, false)).result.blockers.map((row) => `${row.code}:${row.subject}`))
    .toEqual(expect.arrayContaining(["source-drift:new:src/lib/hub-machine/bridge.ts", "stale-receipt:new.default"]));
  // A Hub acknowledgement the machine never settled is recorded as such and never earns, even when both paths agree on it.
  const unsettled: NativeNormalizedOutcome = { status: "unsettled", errorCode: "no-final-receipt", confirmation: false, resultDigest: null };
  const neverSettled = await judgeNativeCoverage(root, inventory, { ...run, outcomes: run.outcomes.map((outcome) => outcome.variantId === "new.default" ? { ...outcome, local: unsettled, headless: unsettled } : outcome) }, hashes, false);
  expect(neverSettled.result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "required-behaviour-refused", subject: "new.default" })]));
  // A forged lifecycle receipt (an outcome edited without re-deriving its digest) and an omitted one are refused.
  const subject = { cwd: root, registryNames: registeredNativeCommandNames(), catalogue: run.catalogue, inventory };
  const forged = verification.receipts.map((receipt) => receipt.variantId === "clear.default" ? { ...receipt, local: { ...receipt.local, outcome: { ...receipt.local.outcome, resultDigest: "f".repeat(64) } } } : receipt);
  expect((await checkNativeCommandCoverage({ ...subject, receipts: forged })).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "tampered-receipt", subject: "clear.default" })]));
  expect((await checkNativeCommandCoverage({ ...subject, receipts: verification.receipts.filter((receipt) => receipt.variantId !== "sessions.picker") })).blockers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-current-evidence", subject: "sessions.picker" })]));
  // A changed source the audit was pinned to: receipts bind the actual bytes, so the committed audit is stale.
  const stale = structuredClone(inventory);
  const status = stale.commands.find((command) => command.commandName === "status")!;
  status.sources[0] = { ...status.sources[0]!, sha256: "0".repeat(64) };
  const drifted = await judgeNativeCoverage(root, stale, run, hashes, false);
  expect(drifted.result.blockers.map((row) => `${row.code}:${row.subject}`)).toEqual(expect.arrayContaining([expect.stringMatching(/^source-drift:status:/), "stale-receipt:status.default"]));
  expect(checkEmbeddedDescriptor(drifted, descriptor, false)).toEqual({ ok: false, code: "inventory-stale" });
  // An omitted nested action: the catalogue advertises a handler with no audit row.
  const omitted = structuredClone(inventory);
  omitted.variants = omitted.variants.filter((row) => row.id !== "rewind.apply");
  omitted.commands.find((command) => command.commandName === "rewind")!.expectedVariants = omitted.commands.find((command) => command.commandName === "rewind")!.expectedVariants.filter((id) => id !== "rewind.apply");
  const missing = await judgeNativeCoverage(root, omitted, { ...run, outcomes: run.outcomes.filter((outcome) => outcome.variantId !== "rewind.apply") }, hashes, false);
  expect(missing.result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "uncovered-catalogue-command", subject: "rewind.apply" })]));
  expect(checkEmbeddedDescriptor(missing, descriptor, false)).toMatchObject({ ok: false });
  // A tampered embedded descriptor claiming an earned variant, and an absent one.
  const tampered = structuredClone(descriptor); tampered.earned.push("connect.select");
  expect(checkEmbeddedDescriptor(verification, tampered, false)).toEqual({ ok: false, code: "descriptor-tampered" });
  expect(checkEmbeddedDescriptor(verification, undefined, false)).toEqual({ ok: false, code: "descriptor-missing" });
  // One full re-execution of every committed variant: about 140 s on a developer machine and longer on the macOS CI runner.
}, 600_000);

test("shipped readiness validates only the embedded descriptor and fails closed when it is missing, tampered or not ready", async () => {
  const { hubMachineCommand } = await import("../src/commands/hub-machine");
  const state = await mkdtemp(join(tmpdir(), "native-readiness-"));
  try {
    const lines: string[] = [];
    await hubMachineCommand(["readiness"], { stateDir: state, write: (line) => lines.push(line) });
    const report = JSON.parse(lines[0]!) as { descriptorValid: boolean; releaseReady: boolean; descriptorDigest: string; requiredGaps: string[] };
    expect(report).toMatchObject({ descriptorValid: true, releaseReady: true, descriptorDigest: (await embedded()).descriptorDigest, requiredGaps: [] });
    await expect(hubMachineCommand(["readiness"], { stateDir: state, write: () => {}, nativeCoverageDescriptor: null })).rejects.toThrow("native-coverage-descriptor-missing");
    const forged = { ...structuredClone(await embedded()), releaseReady: false };
    await expect(hubMachineCommand(["readiness"], { stateDir: state, write: () => {}, nativeCoverageDescriptor: forged })).rejects.toThrow("native-coverage-descriptor-tampered");
    // A valid descriptor of the shipped subject that still names a gap is not ready.
    const shipped = await embedded(); const subject = currentNativeCoverageSubject(); const inventory = await readInventory(root);
    const notReady = buildNativeCoverageDescriptor({ registryNames: subject.registryNames, catalogue: subject.catalogue, contractCatalogue: subject.catalogue, inventory,
      result: { ready: false, registeredCommands: shipped.counts.registeredCommands, auditedVariants: shipped.counts.variants, blockers: [{ code: "missing-current-evidence", subject: "ac.check", detail: "fixture gap" }] } });
    const notReadyLines: string[] = [];
    await expect(hubMachineCommand(["readiness"], { stateDir: state, write: (line) => notReadyLines.push(line), nativeCoverageDescriptor: notReady })).rejects.toThrow("native-coverage-not-ready");
    expect(JSON.parse(notReadyLines[0]!)).toMatchObject({ descriptorValid: true, releaseReady: false, requiredGaps: ["ac.check"] });
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("the packaged readiness path embeds the generated descriptor and has no output JSON or unshipped source dependency", async () => {
  const built = await Bun.build({ entrypoints: [join(root, "src/commands/hub-machine.ts")], target: "bun" });
  expect(built.success).toBe(true);
  const code = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n");
  expect(code).toContain((await embedded()).descriptorDigest);
  for (const forbidden of [INVENTORY_PATH, "native-command-coverage", "output/hub-remote-sessions", "collectParityRun", "PARITY_CASES"]) expect(code).not.toContain(forbidden);
  expect(await readFile(join(root, DESCRIPTOR_PATH), "utf8")).toContain(`"descriptorDigest": "${(await embedded()).descriptorDigest}"`);
});

test("native candidate staging refuses before staging or installing anything when the coverage check fails", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "native-candidate-guard-"));
  try {
    await mkdir(join(fixture, "scripts/smoke"), { recursive: true });
    await writeFile(join(fixture, "scripts/smoke/package-native-candidate.ts"), await readFile(join(root, "scripts/smoke/package-native-candidate.ts"), "utf8"));
    await writeFile(join(fixture, "scripts/verify-native-coverage.ts"), "console.error('native coverage check refused: descriptor-stale'); process.exit(1);\n");
    const output = join(await mkdtemp(join(tmpdir(), "native-candidate-out-")), "candidate");
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/smoke/package-native-candidate.ts", "--out", output], { cwd: fixture, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("without a current validated native coverage descriptor");
    expect(await Bun.file(join(output, "package.json")).exists()).toBe(false);
    expect(canonicalDigest(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: join(output, ".."), onlyFiles: false })))).toBe(canonicalDigest([]));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalDigest } from "../src/remote-control/protocol";
import { receiptParity, type NativeCoverageDescriptor } from "../src/session/commands/coverage";
import { checkEmbeddedDescriptor, collectParityRun, DESCRIPTOR_PATH, INVENTORY_PATH, judgeNativeCoverage, readInventory, receiptsFor, sourceHashes } from "./verify-native-coverage";

const root = resolve(import.meta.dir, "..");
async function embedded(): Promise<NativeCoverageDescriptor> {
  return (await import("../src/session/native-coverage.generated")).NATIVE_COVERAGE_DESCRIPTOR as NativeCoverageDescriptor;
}

test("receipts come from executing the same variant through the real terminal adapter and headless host, and expose failing parity", async () => {
  const inventory = await readInventory(root);
  const run = await collectParityRun(root, inventory, ["status.default", "reasoning.high", "reasoning.off", "trail.tool-NAME", "intake.list", "interrupt.default", "model.select", "history.N-1-20",
    "tasks.kill", "demote.task-id", "flows.list", "rewind.picker", "approvals.allow-once", "status.questions-answer"]);
  const receipts = receiptsFor(inventory, run, await sourceHashes(root, inventory));
  const parity = Object.fromEntries(receipts.map((receipt) => [receipt.variantId, { ...receiptParity(receipt), receipt }]));
  expect(parity["status.default"]).toMatchObject({ matched: true, admitted: true, receipt: { local: { line: "/status", outcome: { status: "applied" } }, headless: { arguments: {}, outcome: { status: "applied" } } } });
  // A real live owned turn is interrupted through both paths.
  expect(parity["interrupt.default"]).toMatchObject({ matched: true, admitted: true });
  // A metered effort change needs the same human confirmation on both paths.
  expect(parity["reasoning.high"]).toMatchObject({ matched: true, admitted: true, receipt: { local: { outcome: { status: "confirmation-required" } } } });
  // The terminal adapter maps `/reasoning off` to the typed `none`, a typed TUI argument and a subcommand to its dotted handler.
  for (const id of ["reasoning.off", "trail.tool-NAME", "intake.list"]) expect({ id, ...receiptParity(parity[id]!.receipt) }).toEqual({ id, matched: true, admitted: true });
  // `/model` is picker-only in the TUI: the terminal refuses the text form while headless selection is accepted, a real parity failure.
  expect(parity["model.select"]).toMatchObject({ matched: false, receipt: { local: { outcome: { errorCode: "invalid-arguments" } }, headless: { outcome: { status: "applied" } } } });
  // Real owners: a supervised session shell task, the Hub's scoped Flow reader, the owned-checkout rewind port.
  for (const id of ["tasks.kill", "demote.task-id", "flows.list", "rewind.picker"]) expect({ id, ...receiptParity(parity[id]!.receipt) }).toEqual({ id, matched: true, admitted: true });
  // A real approval waiter and a real ask_user question are answered headlessly; the terminal has no text form for either, so parity fails.
  for (const id of ["approvals.allow-once", "status.questions-answer"]) expect(parity[id]).toMatchObject({ matched: false, receipt: { local: { outcome: { errorCode: "invalid-arguments" } }, headless: { outcome: { status: "applied" } } } });
  // No typed native request expresses `/history N`; nothing is sent headlessly and nothing is earned.
  expect(parity["history.N-1-20"]).toMatchObject({ matched: false, receipt: { headless: { arguments: null, outcome: null } } });
  for (const receipt of receipts) expect(receipt.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
}, 120_000);

test("release guard re-executes the committed inventory: the embedded descriptor is current, not release-ready, and stale/tampered/missing evidence fails closed", async () => {
  const inventory = await readInventory(root);
  const hashes = await sourceHashes(root, inventory);
  const run = await collectParityRun(root, inventory);
  const verification = await judgeNativeCoverage(root, inventory, run, hashes, false);
  const descriptor = await embedded();
  expect(checkEmbeddedDescriptor(verification, descriptor, false)).toMatchObject({ ok: true });
  // Required gaps stay open and visible, so the release guard refuses.
  expect(checkEmbeddedDescriptor(verification, descriptor, true)).toEqual({ ok: false, code: "not-release-ready" });
  const gaps = descriptor.requiredGaps.map((gap) => gap.variantId);
  for (const id of ["connect.select", "connect.test", "autoreview.start", "autoreview.stop", "risk.working-diff", "conform.run"]) expect(gaps).toContain(id);
  // Telegram remote control is a cited spec-3.1 capability boundary, neither earned nor a hidden gap.
  for (const id of ["remote-control.on", "remote-control.name", "remote-control.off", "remote-control.status"]) { expect(descriptor.boundaries).toContain(id); expect(gaps).not.toContain(id); }
  expect(descriptor.releaseReady).toBe(false);
  expect(descriptor.earned).toEqual(expect.arrayContaining(["status.default", "help.default", "interrupt.default", "settings.read", "tasks.kill", "demote.task-id", "flows.list", "ac.cached", "rewind.picker", "mcp.status", "bus.modal", "mode.show"]));
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
}, 180_000);

test("shipped readiness validates only the embedded descriptor and fails closed when it is missing, tampered or not ready", async () => {
  const { hubMachineCommand } = await import("../src/commands/hub-machine");
  const state = await mkdtemp(join(tmpdir(), "native-readiness-"));
  try {
    const lines: string[] = [];
    await expect(hubMachineCommand(["readiness"], { stateDir: state, write: (line) => lines.push(line) })).rejects.toThrow("native-coverage-not-ready");
    const report = JSON.parse(lines[0]!) as { descriptorValid: boolean; releaseReady: boolean; descriptorDigest: string; requiredGaps: string[] };
    expect(report).toMatchObject({ descriptorValid: true, releaseReady: false, descriptorDigest: (await embedded()).descriptorDigest });
    expect(report.requiredGaps).toContain("connect.select");
    await expect(hubMachineCommand(["readiness"], { stateDir: state, write: () => {}, nativeCoverageDescriptor: null })).rejects.toThrow("native-coverage-descriptor-missing");
    const forged = { ...structuredClone(await embedded()), releaseReady: true, requiredGaps: [], otherBlockers: [] };
    await expect(hubMachineCommand(["readiness"], { stateDir: state, write: () => {}, nativeCoverageDescriptor: forged })).rejects.toThrow("native-coverage-descriptor-tampered");
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

// T57 probe E (row 5 / class residue) — the health report shape guard, at both
// `readLatest` callers (`gate()` and `status()`), and at the real `keryx health
// gate` CLI entry point.
//
// Read-only against production code; every fixture is `mkdtemp` and removed.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeHealthService } from "../../../../src/health/service";
import { healthCommand } from "../../../../src/commands/health";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

async function ws(latest: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t57-health-"));
  const artifacts = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "latest.json"), latest, "utf8");
  await writeFile(
    path.join(root, ".metaproject", "health.config.json"),
    JSON.stringify({ sources: {} }),
    "utf8",
  );
  return root;
}

async function cliExit(root: string, args: string[]): Promise<number | string> {
  const log = console.log;
  const err = console.error;
  const write = process.stdout.write.bind(process.stdout);
  const prev = process.exitCode;
  console.log = () => {};
  console.error = () => {};
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = () => true;
  process.exitCode = 0;
  try {
    await healthCommand(args, root);
    return (process.exitCode as number | undefined) ?? 0;
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    process.exitCode = prev;
    console.log = log;
    console.error = err;
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

const full = (gate: unknown) =>
  JSON.stringify({ gate, metrics: [], findings: [], sources: [], generatedAt: "2026-01-01T00:00:00Z" });

const CASES: [string, string][] = [
  ["E01 gate.status pass", full({ status: "pass", reasons: [] })],
  ["E02 gate.status warn", full({ status: "warn", reasons: ["r"] })],
  ["E03 gate.status incomplete", full({ status: "incomplete", reasons: ["required source unavailable"] })],
  ["E04 gate.status fail", full({ status: "fail", reasons: ["violation"] })],
  ["E05 gate.status banana (unrecognized)", full({ status: "banana", reasons: ["r"] })],
  ["E06 no gate key", JSON.stringify({ metrics: [], findings: [], sources: [] })],
  ["E07 whole payload is a bare array", "[]"],
  ["E08 gate is a string", JSON.stringify({ gate: "incomplete" })],
  ["E09 gate is an array", JSON.stringify({ gate: [], metrics: [], sources: [] })],
  ["E10 gate is null", JSON.stringify({ gate: null, metrics: [], sources: [] })],
  ["E11 gate.status is a number", full({ status: 1, reasons: [] })],
  ["E12 gate.reasons is a string", full({ status: "pass", reasons: "r" })],
  ["E13 gate.reasons absent", JSON.stringify({ gate: { status: "pass" }, metrics: [], sources: [] })],
  ["E14 payload unparseable", "{not json"],
  ["E15 payload is null", "null"],
  ["E16 payload is a number", "42"],
  ["E17 __proto__ carrying a passing gate", JSON.stringify({ __proto__: { gate: { status: "pass", reasons: [] } } })],
  // Gate shape sound, but the REST of the report is missing. `status()` reads
  // `latest.metrics` / `latest.sources`, which `hasGateShape` does not validate.
  ["E18 gate shape sound, metrics/sources ABSENT", JSON.stringify({ gate: { status: "pass", reasons: [] } })],
  ["E19 gate shape sound, metrics is a string", JSON.stringify({ gate: { status: "fail", reasons: ["v"] }, metrics: "x", sources: [] })],
];

for (const [label, body] of CASES) {
  const root = await ws(body);
  try {
    let gateThrew: string | null = null;
    let gateResult: unknown = null;
    try {
      gateResult = await createCodeHealthService().gate({ cwd: root });
    } catch (e) {
      gateThrew = e instanceof Error ? e.message : String(e);
    }
    let statusThrew: string | null = null;
    let statusGate: unknown = null;
    try {
      statusGate = (await createCodeHealthService().status({ cwd: root })).gate;
    } catch (e) {
      statusThrew = e instanceof Error ? e.message : String(e);
    }
    const cli = await cliExit(root, ["gate"]);
    out({
      label,
      gateThrew,
      gateResult,
      statusThrew,
      statusGate,
      cliHealthGateExit: cli,
      leaky:
        JSON.stringify(gateResult ?? "").includes(root) ||
        JSON.stringify(gateResult ?? "").includes("JSON"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

out({
  label: "E99 prototype hygiene",
  protoGate: (Object.prototype as unknown as { gate?: unknown }).gate ?? null,
});

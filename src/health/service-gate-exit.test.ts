import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeHealthService } from "./service";

/**
 * Regression coverage for `CodeHealthService.gate()`'s exit-code fold
 * (`src/health/service.ts`). `gate()` reads `latest.gate.status` from an
 * on-disk `latest.json` through an unchecked `as HealthReport` cast
 * (`readLatest`), so an unrecognized/corrupted status string is reachable
 * at runtime even though `GateStatus` closes the type. This file writes
 * that fixture directly — no `as unknown as GateStatus` cast needed,
 * unlike a purely in-process fold — to exercise the real `readLatest()`
 * parse path end to end, the same seam `src/commands/health-incomplete.test.ts`
 * already uses for its own `gate()` fixtures.
 */

async function writeLatestGate(
  root: string,
  gate: { status: string; reasons: string[]; coverage?: "complete" | "incomplete" },
): Promise<void> {
  const artifacts = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(root, ".metaproject", "health.config.json"), "{}\n", "utf8");
  const report = {
    schemaVersion: 2,
    generatedAt: "2026-09-06T00:00:00.000Z",
    scope: "project",
    strict: true,
    gitRef: null,
    gate,
    sources: [],
    metrics: [],
    findings: [],
  };
  await writeFile(path.join(artifacts, "latest.json"), `${JSON.stringify(report)}\n`, "utf8");
}

test("gate() passes a clean pass control at both strictWarn settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-pass-"));
  try {
    await writeLatestGate(root, { status: "pass", reasons: ["PASS: no gate conditions triggered"] });
    const service = createCodeHealthService();

    const loose = await service.gate({ cwd: root });
    expect(loose.status).toBe("pass");
    expect(loose.exitCode).toBe(0);

    const strict = await service.gate({ cwd: root, strictWarn: true });
    expect(strict.status).toBe("pass");
    expect(strict.exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate() blocks fail and incomplete unconditionally, independent of strictWarn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-blocking-"));
  try {
    const service = createCodeHealthService();

    await writeLatestGate(root, { status: "fail", reasons: ["FAIL: synthetic threshold violation"] });
    expect((await service.gate({ cwd: root })).exitCode).toBe(1);
    expect((await service.gate({ cwd: root, strictWarn: true })).exitCode).toBe(1);

    await writeLatestGate(root, {
      status: "incomplete",
      reasons: ["INCOMPLETE: required source unavailable: eslint"],
    });
    expect((await service.gate({ cwd: root })).exitCode).toBe(1);
    expect((await service.gate({ cwd: root, strictWarn: true })).exitCode).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate() warns without strictWarn but never signs warn as passed, and blocks it under strictWarn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-warn-"));
  try {
    await writeLatestGate(root, { status: "warn", reasons: ["WARN: synthetic soft-floor coverage"] });
    const service = createCodeHealthService();

    const loose = await service.gate({ cwd: root });
    expect(loose.exitCode).toBe(0);
    expect(loose.status).toBe("warn");
    expect(loose.status).not.toBe("pass");

    const strict = await service.gate({ cwd: root, strictWarn: true });
    expect(strict.exitCode).toBe(1);
    expect(strict.status).toBe("warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate() fails closed on an unrecognized/corrupted status instead of falling through to a pass exit code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-unrecognized-"));
  try {
    await writeLatestGate(root, {
      status: "banana",
      reasons: ["synthetic corrupted/unrecognized gate status"],
    });
    const service = createCodeHealthService();

    const loose = await service.gate({ cwd: root });
    expect(loose.exitCode).toBe(1);
    expect(loose.status).not.toBe("pass");

    const strict = await service.gate({ cwd: root, strictWarn: true });
    expect(strict.exitCode).toBe(1);
    expect(strict.status).not.toBe("pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * T39 F-004: T50 guarded the `gate.status` VALUE but not the shape around
 * it. A stored `latest.json` with no `gate` key at all — or `gate` present
 * but not the object `{status, reasons}` `gate()` expects — made
 * `latest.gate.status` throw a raw `TypeError` out of the method instead of
 * the module's own "no report; run `keryx health run` first" refusal that
 * already exists one branch up for a genuinely absent report. Both fixtures
 * below write raw JSON directly (not through `writeLatestGate`, which always
 * writes a well-shaped `gate` object) to reach that shape hole through the
 * real `readLatest()` parse path.
 */
async function writeRawLatest(root: string, payload: unknown): Promise<void> {
  const artifacts = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(root, ".metaproject", "health.config.json"), "{}\n", "utf8");
  await writeFile(path.join(artifacts, "latest.json"), `${JSON.stringify(payload)}\n`, "utf8");
}

test("gate() treats a stored report with no gate key as unusable evidence, not a thrown error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-no-gate-key-"));
  try {
    await writeRawLatest(root, {
      schemaVersion: 2,
      generatedAt: "2026-09-06T00:00:00.000Z",
      scope: "project",
      strict: true,
      gitRef: null,
      sources: [],
      metrics: [],
      findings: [],
      // no `gate` key at all
    });
    const service = createCodeHealthService();

    const result = await service.gate({ cwd: root });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.reasons).toEqual(["no report; run `keryx health run` first"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * T43: the same fixture set one level out — the stored report itself is not an
 * object, or does not parse at all. These outcomes were correct before this
 * task but only by accident of member access: `readLatest` cast the parse
 * result to `HealthReport` and then read `latest.record`, so `null` produced a
 * `TypeError` that the surrounding `catch` happened to swallow, and a bare
 * string produced `undefined` that `hasGateShape` happened to reject. They are
 * now decided by the shape-aware reader before any member is touched, and these
 * rows pin that the verdict did not move.
 */
test("gate() treats a stored report that is not an object, or does not parse, as unusable evidence", async () => {
  for (const body of ["null", '"pass"', "[]", "42", "{not json", "", "   \n "]) {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-nonobject-"));
    try {
      const artifacts = path.join(root, ".metaproject", "data", "health", "artifacts");
      await mkdir(artifacts, { recursive: true });
      await writeFile(path.join(root, ".metaproject", "health.config.json"), "{}\n", "utf8");
      await writeFile(path.join(artifacts, "latest.json"), body, "utf8");

      const result = await createCodeHealthService().gate({ cwd: root });
      expect(result.status).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.reasons).toEqual(["no report; run `keryx health run` first"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("gate() treats a stored report whose gate is a bare array as unusable evidence, not a thrown error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-gate-array-"));
  try {
    await writeRawLatest(root, {
      schemaVersion: 2,
      generatedAt: "2026-09-06T00:00:00.000Z",
      scope: "project",
      strict: true,
      gitRef: null,
      gate: [],
      sources: [],
      metrics: [],
      findings: [],
    });
    const service = createCodeHealthService();

    const result = await service.gate({ cwd: root });
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.reasons).toEqual(["no report; run `keryx health run` first"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * T57 F-003: `hasGateShape` validated `gate` but not the rest of the shape,
 * so a stored report whose `gate` is perfectly well-formed but whose
 * `metrics`/`sources`/`findings` are absent or wrongly typed still threw a
 * raw `TypeError` out of `status()` (and, independently found while
 * enumerating every reader for T61, out of `explain()` too) at
 * `latest?.metrics.find`/`latest.findings.filter`. Verified through all
 * three cheap, directly callable readers — `gate()`, `status()`,
 * `explain()` — mirroring the reviewer's own probe rows E18/E19
 * (`T57-health.ts`).
 */
test("a stored report with a sound gate but ABSENT metrics/sources/findings is unusable evidence at gate(), status() and explain(), not a thrown error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-no-metrics-"));
  try {
    await writeRawLatest(root, {
      schemaVersion: 2,
      generatedAt: "2026-09-06T00:00:00.000Z",
      scope: "project",
      strict: true,
      gitRef: null,
      gate: { status: "pass", reasons: [] },
      // no `metrics`, `sources`, or `findings` key at all
    });
    const service = createCodeHealthService();

    const gateResult = await service.gate({ cwd: root });
    expect(gateResult.status).toBe("fail");
    expect(gateResult.exitCode).toBe(1);
    expect(gateResult.reasons).toEqual(["no report; run `keryx health run` first"]);

    const statusResult = await service.status({ cwd: root });
    expect(statusResult.gate).toBeNull();
    expect(statusResult.sources).toEqual([]);
    expect(statusResult.projectScore).toBeNull();
    expect(statusResult.regressions).toBe(0);

    const explainResult = await service.explain({ cwd: root, target: "project" });
    expect(explainResult.found).toBe(false);
    expect(explainResult.metrics).toBeNull();
    expect(explainResult.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stored report with a sound gate but metrics as a STRING is unusable evidence at gate(), status() and explain(), not a thrown error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-health-gate-exit-metrics-string-"));
  try {
    await writeRawLatest(root, {
      schemaVersion: 2,
      generatedAt: "2026-09-06T00:00:00.000Z",
      scope: "project",
      strict: true,
      gitRef: null,
      gate: { status: "fail", reasons: ["v"] },
      metrics: "not-an-array",
      sources: [],
      findings: [],
    });
    const service = createCodeHealthService();

    const gateResult = await service.gate({ cwd: root });
    expect(gateResult.status).toBe("fail");
    expect(gateResult.exitCode).toBe(1);
    expect(gateResult.reasons).toEqual(["no report; run `keryx health run` first"]);

    const statusResult = await service.status({ cwd: root });
    expect(statusResult.gate).toBeNull();
    expect(statusResult.projectScore).toBeNull();

    const explainResult = await service.explain({ cwd: root, target: "project" });
    expect(explainResult.found).toBe(false);
    expect(explainResult.metrics).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

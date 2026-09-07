// T62 probe — rows 4 and 5.
//
// Row 4: the shape guard at `readLatest`, checked at ALL FOUR readers,
// including `updateBaseline()` — the one T61 disclosed as having no dedicated
// regression — and including `readLatest`'s second, indirect path (a
// `latest.json` whose `record` is a pointer to another file), which T57's own
// probe did not exercise.
//
// Row 5: the unusable-health-config branch. The verdict is measured at the REAL
// entry point (`createCodeHealthService().run({cwd})` -> `run.ts`'s own
// `computeGate` call), not only by calling `computeGate` with a hand-built
// config, so a change made in the loader is observed where it lands.
//
// Read-only against production code; every fixture is `mkdtemp`, removed in
// `finally`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeHealthService } from "../../../../src/health/service";
import { loadHealthConfig } from "../../../../src/health/config";
import { computeGate } from "../../../../src/health/gate";
import type { HealthConfig, ScopeMetrics, SourceRunInfo } from "../../../../src/health/types";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const SECRET = "AKIAIOSFODNN7EXAMPLE";

async function ws(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

async function writeLatestRaw(root: string, body: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "latest.json"), body, "utf8");
}

const SOUND_GATE = { status: "pass", reasons: [] as string[] };

function report(extra: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-07-07T09:00:00Z",
    gate: SOUND_GATE,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Row 4 — the shape matrix, at all four readers.
// ---------------------------------------------------------------------------
const SHAPES: [string, string][] = [
  ["H01 well-formed (control)", report({ metrics: [], sources: [], findings: [] })],
  ["H02 gate sound, metrics ABSENT", report({ sources: [], findings: [] })],
  ["H03 gate sound, sources ABSENT", report({ metrics: [], findings: [] })],
  ["H04 gate sound, findings ABSENT", report({ metrics: [], sources: [] })],
  ["H05 gate sound, all three ABSENT", report({})],
  ["H06 metrics a string", report({ metrics: "x", sources: [], findings: [] })],
  ["H07 sources a string", report({ metrics: [], sources: "x", findings: [] })],
  ["H08 findings a string", report({ metrics: [], sources: [], findings: "x" })],
  ["H09 metrics an object", report({ metrics: {}, sources: [], findings: [] })],
  ["H10 metrics null", report({ metrics: null, sources: [], findings: [] })],
  ["H11 findings a number", report({ metrics: [], sources: [], findings: 3 })],
  [
    "H12 __proto__ supplying the arrays",
    `{"schemaVersion":1,"gate":{"status":"pass","reasons":[]},"__proto__":{"metrics":[],"sources":[],"findings":[]}}`,
  ],
  ["H13 no gate key at all", JSON.stringify({ metrics: [], sources: [], findings: [] })],
  ["H14 whole payload null", "null"],
  ["H15 whole payload unparseable", "{not json"],
  [
    "H16 gate sound, metrics absent, planted secret in gate.reasons",
    JSON.stringify({ gate: { status: "pass", reasons: [`planted ${SECRET}`] }, sources: [], findings: [] }),
  ],
];

for (const [label, body] of SHAPES) {
  const root = await ws("t62-health-");
  try {
    await writeLatestRaw(root, body);
    const svc = createCodeHealthService();

    let gateThrew: string | null = null;
    let gateResult: unknown = null;
    try {
      gateResult = await svc.gate({ cwd: root });
    } catch (e) {
      gateThrew = e instanceof Error ? e.message : String(e);
    }

    let statusThrew: string | null = null;
    let statusResult: unknown = null;
    try {
      statusResult = await svc.status({ cwd: root });
    } catch (e) {
      statusThrew = e instanceof Error ? e.message : String(e);
    }

    let explainThrew: string | null = null;
    let explainResult: unknown = null;
    try {
      explainResult = await svc.explain({ cwd: root, target: "project" });
    } catch (e) {
      explainThrew = e instanceof Error ? e.message : String(e);
    }

    // updateBaseline: the reader T61 disclosed as having NO dedicated
    // regression. Its fallback recomputes via a real `runHealth()`, which is
    // the expensive path — it is exercised here precisely because nothing else
    // does.
    let baselineThrew: string | null = null;
    let baselineResult: unknown = null;
    try {
      baselineResult = await svc.updateBaseline({ cwd: root } as never);
    } catch (e) {
      baselineThrew = e instanceof Error ? e.message : String(e);
    }

    const serialized = JSON.stringify({ gateResult, statusResult, explainResult, baselineResult });
    out({
      label,
      gateThrew,
      gateStatus: (gateResult as { status?: string } | null)?.status ?? null,
      gateReasons: (gateResult as { reasons?: string[] } | null)?.reasons ?? null,
      statusThrew,
      statusGate: (statusResult as { gate?: string | null } | null)?.gate ?? null,
      explainThrew,
      explainFound: (explainResult as { found?: boolean } | null)?.found ?? null,
      baselineThrew,
      baselineUpdated: (baselineResult as { updated?: unknown } | null)?.updated ?? null,
      leakedSecret: serialized.includes(SECRET),
      leakedPath: serialized.includes(root),
    });
  } catch (e) {
    out({ label, harnessError: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Row 4b — `readLatest`'s SECOND path: `latest.json` carries a `record` string
// pointing at another artifact file. T57's probe never drove it.
// ---------------------------------------------------------------------------
for (const [label, recordBody] of [
  ["H20 record pointer -> well-formed record", report({ metrics: [], sources: [], findings: [] })],
  ["H21 record pointer -> record with metrics ABSENT", report({ sources: [], findings: [] })],
  ["H22 record pointer -> record with no gate", JSON.stringify({ metrics: [], sources: [], findings: [] })],
] as [string, string][]) {
  const root = await ws("t62-healthrec-");
  try {
    const dir = path.join(root, ".metaproject", "data", "health", "artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "record-1.json"), recordBody, "utf8");
    await writeFile(
      path.join(dir, "latest.json"),
      JSON.stringify({ record: "record-1.json" }),
      "utf8",
    );
    const svc = createCodeHealthService();
    let gateThrew: string | null = null;
    let gateResult: unknown = null;
    try {
      gateResult = await svc.gate({ cwd: root });
    } catch (e) {
      gateThrew = e instanceof Error ? e.message : String(e);
    }
    let statusThrew: string | null = null;
    try {
      await svc.status({ cwd: root });
    } catch (e) {
      statusThrew = e instanceof Error ? e.message : String(e);
    }
    out({
      label,
      gateThrew,
      gateStatus: (gateResult as { status?: string } | null)?.status ?? null,
      statusThrew,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Row 5 — the health config branch. First the loader itself, from disk.
// ---------------------------------------------------------------------------
const CONFIGS: [string, string | null][] = [
  ["G01 absent", null],
  ["G02 well-formed default-ish", JSON.stringify({ schemaVersion: 1 })],
  [
    "G03 well-formed, operator tightened softFloor to 90",
    JSON.stringify({ schemaVersion: 1, metrics: { coverageSoftFloor: 90 } }),
  ],
  ["G04 unusable: null", "null"],
  ["G05 unusable: 42", "42"],
  ["G06 unusable: unparseable", "{oops"],
  ["G07 unusable: array", "[]"],
  ["G08 unusable: string", '"advisory"'],
  ["G09 unusable: true", "true"],
];

const loaded: Record<string, HealthConfig> = {};

for (const [label, body] of CONFIGS) {
  const root = await ws("t62-hcfg-");
  try {
    if (body !== null) {
      await writeFile(path.join(root, ".metaproject", "health.config.json"), body, "utf8");
    }
    const cfg = await loadHealthConfig(root);
    loaded[label] = cfg;
    out({
      label,
      configUnreadable: cfg.configUnreadable ?? null,
      coverageSoftFloor: cfg.metrics.coverageSoftFloor,
      coverageTarget: cfg.metrics.coverageTarget,
      failOnPriorities: cfg.gate.failOnPriorities,
      failOnRegressionDrop: cfg.gate.failOnRegressionDrop,
      warnOnRegressionDrop: cfg.gate.warnOnRegressionDrop,
      allSourcesRequired: Object.values(cfg.sources).every((s) => s.required === true),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Does the verdict move? Same inputs, the three loader outcomes, through the
// real `computeGate`. Coverage is deliberately set to 70 — above the plain
// default soft floor of 60 and below the forced ceiling of 100 — which is the
// band where forcing `coverageSoftFloor` DOES change the outcome.
{
  const metrics = (coverage: number | undefined): ScopeMetrics =>
    ({
      key: "project",
      name: "project",
      kind: "project",
      health_score: 90,
      regression_score: 0,
      trend: "stable",
      ...(coverage === undefined ? {} : { coverage }),
    }) as unknown as ScopeMetrics;
  const sources: SourceRunInfo[] = [
    { source: "eslint", mode: "run", required: true, status: "available", execution: "ok", parse: "ok", findings: 0 } as unknown as SourceRunInfo,
  ];
  for (const [cfgLabel, cfg] of Object.entries(loaded)) {
    for (const coverage of [undefined, 41, 70, 100]) {
      const r = computeGate({ findings: [], projectMetrics: metrics(coverage), sources, config: cfg, strict: false });
      out({
        label: "G20 computeGate verdict",
        config: cfgLabel,
        coverage: coverage ?? "absent",
        status: r.status,
        coverageField: r.coverage,
        reasons: r.reasons,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Row 5b — the verdict at the REAL entry point. `createCodeHealthService().run`
// loads the config from disk itself and calls `computeGate` at `run.ts:152`.
// ---------------------------------------------------------------------------
for (const [label, body] of [
  ["G30 real run, absent config", null],
  ["G31 real run, well-formed config", JSON.stringify({ schemaVersion: 1 })],
  ["G32 real run, unusable config (null)", "null"],
] as [string, string | null][]) {
  const root = await ws("t62-hrun-");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    if (body !== null) {
      await writeFile(path.join(root, ".metaproject", "health.config.json"), body, "utf8");
    }
    const result = await createCodeHealthService().run({ cwd: root } as never);
    const gate = (result as { report?: { gate?: { status?: string; reasons?: string[] } } }).report?.gate;
    out({
      label,
      gateStatus: gate?.status ?? null,
      gateReasons: gate?.reasons ?? null,
      mentionsConfigUnreadable: (gate?.reasons ?? []).some((r) => /CONFIG: health configuration is unreadable/.test(r)),
      leakedPath: JSON.stringify(gate?.reasons ?? []).includes(root),
      leakedJsonWord: (gate?.reasons ?? []).some((r) => /JSON|SyntaxError|ENOENT|Unexpected/.test(r)),
    });
  } catch (e) {
    out({ label, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Row 5c — an operator value ABOVE the forced ceiling. The loader's comment
// argues 100 is "provably at least as strict as any real operator's setting"
// because "every legal coverageSoftFloor a real config could set is <= 100".
// Nothing validates that. Measure whether the claim holds against a config
// this loader actually accepts.
// ---------------------------------------------------------------------------
{
  const root = await ws("t62-hceil-");
  try {
    await writeFile(
      path.join(root, ".metaproject", "health.config.json"),
      JSON.stringify({ schemaVersion: 1, metrics: { coverageSoftFloor: 150 } }),
      "utf8",
    );
    const real = await loadHealthConfig(root);
    await writeFile(path.join(root, ".metaproject", "health.config.json"), "null", "utf8");
    const forced = await loadHealthConfig(root);
    const metrics = { key: "project", name: "project", kind: "project", health_score: 90, regression_score: 0, trend: "stable", coverage: 100 } as unknown as ScopeMetrics;
    const sources: SourceRunInfo[] = [];
    const realGate = computeGate({ findings: [], projectMetrics: metrics, sources, config: real, strict: false });
    const forcedGate = computeGate({ findings: [], projectMetrics: metrics, sources, config: forced, strict: false });
    out({
      label: "G40 operator softFloor above the forced ceiling",
      acceptedByLoader: real.metrics.coverageSoftFloor,
      forcedValue: forced.metrics.coverageSoftFloor,
      realGateStatus: realGate.status,
      forcedGateStatus: forcedGate.status,
      forcedIsAtLeastAsStrict: !(realGate.status === "warn" && forcedGate.status === "pass"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

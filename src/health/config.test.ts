import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_HEALTH_CONFIG, loadHealthConfig } from "./config";
import type { Priority } from "./types";

// T59: `loadHealthConfig` reads `.metaproject/health.config.json` through
// `readJsonFileOr` and then accesses fields off the parsed payload without
// checking it is an object first. A file containing the four bytes `null`
// throws (`Cannot read properties of null (reading 'schemaVersion')`) and
// every other non-object/unparseable payload falls through to plain
// `DEFAULT_HEALTH_CONFIG` silently -- reverting an operator's tightened gate
// thresholds with no signal. See T59-spec.md / T59-implementation.md.

async function withConfigFile(
  body: string,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-health-config-unusable-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "health.config.json"), body, "utf8");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ALL_PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

function expectStrictestGate(config: Awaited<ReturnType<typeof loadHealthConfig>>): void {
  // Provably at least as strict as any real operator config: every legal
  // `failOnPriorities` is a subset of these four, and every legal drop
  // threshold is non-negative, so 0 is the floor.
  expect([...config.gate.failOnPriorities].sort()).toEqual(ALL_PRIORITIES);
  expect(config.gate.failOnRegressionDrop).toBe(0);
  expect(config.gate.warnOnRegressionDrop).toBe(0);
  expect(config.gate.failOnMissingRequiredSource).toBe(true);
  for (const [id, cfg] of Object.entries(config.sources)) {
    expect(cfg.required).toBe(true);
    // Not the trap: `sonarqube`'s default MODE stays `"disabled"`, which is
    // what makes it deterministically "skipped" (never "available") and thus
    // a broken required source regardless of the project under test.
    if (id === "sonarqube") {
      expect(cfg.mode).toBe("disabled");
    }
  }
}

test("a health config of the four-byte empty value does not throw", async () => {
  await withConfigFile("null", async (root) => {
    const config = await loadHealthConfig(root);
    expect(config).toBeDefined();
    expectStrictestGate(config);
  });
});

test("a non-object payload does not silently restore default gate thresholds", async () => {
  await withConfigFile("42", async (root) => {
    const config = await loadHealthConfig(root);
    // The bug: this used to equal DEFAULT_HEALTH_CONFIG.gate exactly, because
    // `(42).schemaVersion` etc. all auto-box to `undefined` and every `??`
    // falls through. Assert the opposite of that silent fallback.
    expect(config.gate).not.toEqual(DEFAULT_HEALTH_CONFIG.gate);
    expectStrictestGate(config);
  });
});

test("an array payload does not silently restore default gate thresholds", async () => {
  await withConfigFile("[]", async (root) => {
    const config = await loadHealthConfig(root);
    expect(config.gate).not.toEqual(DEFAULT_HEALTH_CONFIG.gate);
    expectStrictestGate(config);
  });
});

test("a string payload does not silently restore default gate thresholds", async () => {
  await withConfigFile('"advisory"', async (root) => {
    const config = await loadHealthConfig(root);
    expectStrictestGate(config);
  });
});

test("unparseable JSON is treated the same as a non-object payload", async () => {
  await withConfigFile("{not valid json", async (root) => {
    const config = await loadHealthConfig(root);
    expectStrictestGate(config);
  });
});

test("non-gate blocks fall back to the built-in default for an unusable config", async () => {
  await withConfigFile("null", async (root) => {
    const config = await loadHealthConfig(root);
    // T64: `metrics.coverageSoftFloor` is the one field of `metrics` that
    // `computeGate` reads for a gate decision (`gate.ts` -- the coverage-warn
    // escalation); `coverageTarget` feeds the health *score*
    // (`scoring.ts`), not the gate, and neither `complexityThreshold`,
    // `churnWindowDays` nor `hotspotThreshold` is read by `computeGate` at
    // all. So `coverageSoftFloor` is corrected here to the same
    // strictest-value treatment as `gate`/`sources[*].required` (see
    // T64-implementation.md); the rest of `metrics` is unchanged, matching
    // an absent file exactly as before.
    const { coverageSoftFloor, ...restMetrics } = config.metrics;
    const { coverageSoftFloor: defaultSoftFloor, ...restDefaultMetrics } =
      DEFAULT_HEALTH_CONFIG.metrics;
    expect(restMetrics).toEqual(restDefaultMetrics);
    expect(coverageSoftFloor).toBe(100);
    expect(coverageSoftFloor).not.toBe(defaultSoftFloor);
    expect(config.scoring).toEqual(DEFAULT_HEALTH_CONFIG.scoring);
    expect(config.ignore.paths).toEqual(DEFAULT_HEALTH_CONFIG.ignore.paths);
    expect(config.schemaVersion).toBe(DEFAULT_HEALTH_CONFIG.schemaVersion);
  });
});

test("an unusable config sets configUnreadable; absent and well-formed configs do not", async () => {
  await withConfigFile("null", async (root) => {
    const config = await loadHealthConfig(root);
    expect(config.configUnreadable).toBe(true);
  });
  await withConfigFile("42", async (root) => {
    const config = await loadHealthConfig(root);
    expect(config.configUnreadable).toBe(true);
  });
  await withConfigFile("{not valid json", async (root) => {
    const config = await loadHealthConfig(root);
    expect(config.configUnreadable).toBe(true);
  });
  const absent = await loadHealthConfig("/nonexistent-project-xyz");
  expect(absent.configUnreadable).toBeUndefined();
  await withConfigFile(JSON.stringify({ gate: { failOnPriorities: ["P0", "P1"] } }), async (root) => {
    const config = await loadHealthConfig(root);
    expect(config.configUnreadable).toBeUndefined();
  });
});

test("a well-formed config with tightened thresholds survives unchanged", async () => {
  await withConfigFile(
    JSON.stringify({
      gate: {
        failOnPriorities: ["P0", "P1"],
        failOnRegressionDrop: 4,
        warnOnRegressionDrop: 1,
      },
      sources: { sonarqube: { mode: "auto", required: true } },
      metrics: { coverageSoftFloor: 75 },
      ignore: { paths: ["custom-tightened/**"] },
    }),
    async (root) => {
      const config = await loadHealthConfig(root);
      expect(config.gate.failOnPriorities).toEqual(["P0", "P1"]);
      expect(config.gate.failOnRegressionDrop).toBe(4);
      expect(config.gate.warnOnRegressionDrop).toBe(1);
      expect(config.sources.sonarqube).toEqual({ mode: "auto", required: true });
      expect(config.metrics.coverageSoftFloor).toBe(75);
      expect(config.ignore.paths).toContain("custom-tightened/**");
      expect(config.ignore.paths).toContain("storybook-static/**");
    },
  );
});

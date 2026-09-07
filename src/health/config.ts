import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";
import type { HealthConfig } from "./types";

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  schemaVersion: 2,
  ignore: {
    paths: [
      "node_modules/**",
      ".git/**",
      ".metaproject/**",
      "dist/**",
      "build/**",
      "coverage/**",
      ".next/**",
      "out/**",
      "storybook-static/**",
      "**/storybook-static/**",
      "public/**",
      "**/public/**",
      "assets/**",
      "**/public/assets/**",
      "static/**",
      "**/static/**",
      "generated/**",
      "**/generated/**",
    ],
  },
  sources: {
    eslint: { mode: "auto", required: true },
    typescript: { mode: "auto", required: true },
    tests: { mode: "auto", required: false },
    coverage: { mode: "import", required: false },
    dependencyAudit: { mode: "auto", required: false },
    sonarqube: { mode: "disabled", required: false },
    complexity: { mode: "auto", required: false },
  },
  metrics: {
    coverageTarget: 80,
    coverageSoftFloor: 60,
    complexityThreshold: 10,
    churnWindowDays: 90,
    hotspotThreshold: 0,
  },
  scoring: {
    priorityWeights: { P0: 100, P1: 20, P2: 5, P3: 1 },
    coverageWeight: 1,
    complexityWeight: 2,
    normalizePerLoc: 1000,
    hotspotWeight: 0,
  },
  gate: {
    failOnPriorities: ["P0"],
    failOnRegressionDrop: 10,
    warnOnRegressionDrop: 3,
    failOnMissingRequiredSource: true,
  },
};

export function configPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "health.config.json");
}

// The strictest `gate` this type can express, forced when the config file
// EXISTS but cannot be trusted (see the "Present, unusable" branch below).
// Provably at least as strict as any config a real operator could have
// written: every legal `failOnPriorities` is a subset of these four values,
// and every legal drop threshold is non-negative, so 0 is the floor.
const STRICTEST_GATE: HealthConfig["gate"] = {
  failOnPriorities: ["P0", "P1", "P2", "P3"],
  failOnRegressionDrop: 0,
  warnOnRegressionDrop: 0,
  failOnMissingRequiredSource: true,
};

export async function loadHealthConfig(cwd: string): Promise<HealthConfig> {
  const file = configPath(cwd);
  if (!(await pathExists(file))) {
    // Absent: the ordinary "never configured" case. Unchanged.
    return DEFAULT_HEALTH_CONFIG;
  }

  const base = DEFAULT_HEALTH_CONFIG;
  // `readJsonObjectFile` (`../lib/json`, added by T43 under the ruling in
  // `T39-review.md` "Judgement calls" #4) answers "did it parse" and "is it
  // the object this loader can merge" in one result, replacing the old
  // `readJsonFileOr<Partial<HealthConfig>>(file, {})` read that accessed
  // fields off the parsed payload without checking it was an object first --
  // a file containing the four bytes `null` threw, and every other
  // non-object or unparseable payload silently fell through to
  // `DEFAULT_HEALTH_CONFIG`, reverting an operator's tightened gate
  // thresholds with no signal (T43-implementation.md §3b; full argument in
  // T59-implementation.md).
  const read = await readJsonObjectFile(file);

  if (read.state !== "object") {
    // Present, but unusable: invalid JSON (`state: "unreadable"`), or JSON
    // that parses to something other than a plain object (`state:
    // "non-object"` -- `null`, an array, a number, a string, a boolean).
    // Different from "absent" above: this file WAS configured and its bytes
    // cannot be trusted, so nothing it might have said can be merged in.
    //
    // `gate` and every source's `required` flag are the two gate-relevant
    // parts of this config (`src/health/gate.ts` reads `gate.failOnPriorities`,
    // `gate.failOnRegressionDrop`, `gate.warnOnRegressionDrop` directly, and a
    // required-but-unavailable source escalates the gate to `incomplete` --
    // exactly `policies.md`'s "required check missing/skipped/unparsed" ->
    // INCOMPLETE fold). Both are forced to the strictest value this type can
    // express, through the existing, UNMODIFIED `computeGate()`: forcing
    // every source's `required` to `true` guarantees at least one source
    // (`sonarqube`, `mode:"disabled"` by default here, so its status is
    // always `"skipped"`, never `"available"`) is a broken required source,
    // deterministically escalating to `incomplete` regardless of what the
    // corrupted file might have said. `ignore`, `scoring`, `schemaVersion`,
    // and every `metrics` field except `coverageSoftFloor` (forced below,
    // T64) are not gate-relevant by that same criterion and fall back to the
    // built-in default, same as an absent file.
    //
    // `src/security/config.ts` resolves the identical question by forcing
    // `mode` to its strictest recognized value and setting a
    // `configUnreadable` flag its type already carries. `HealthConfig` now
    // carries the same flag (T64, `types.ts`) -- set here, and turned into a
    // discrete, constant, leak-safe reason by `computeGate` (`gate.ts`), the
    // same way `guard.ts` turns `SecurityConfig.configUnreadable` into
    // `POSTURE_UNAVAILABLE_REASON`. See T59-implementation.md for the full
    // three-case description and T64-implementation.md for the flag/reason
    // decision.
    const sources: HealthConfig["sources"] = {};
    for (const [id, cfg] of Object.entries(base.sources)) {
      sources[id] = { ...cfg, required: true };
    }
    // T64: `metrics.coverageSoftFloor` is the one `metrics` field
    // `computeGate` reads for a gate decision (its coverage-warn escalation,
    // `gate.ts`); no other `metrics` field affects the gate (`coverageTarget`
    // feeds the health score in `scoring.ts`, not the gate). Left at the
    // plain default it would silently revert an operator's tightened warn
    // threshold exactly like the T59 bug this branch otherwise closes, so it
    // is forced to the ceiling of its percentage range: `coverage < 100` is
    // the maximal trigger this comparison can express, and every legal
    // `coverageSoftFloor` a real config could set is <= 100.
    return {
      ...base,
      sources,
      gate: STRICTEST_GATE,
      metrics: { ...base.metrics, coverageSoftFloor: 100 },
      configUnreadable: true,
    };
  }

  const parsed = read.value as Partial<HealthConfig>;
  return {
    schemaVersion: parsed.schemaVersion ?? base.schemaVersion,
    ignore: {
      paths: [...new Set([...base.ignore.paths, ...(parsed.ignore?.paths ?? [])])],
    },
    sources: { ...base.sources, ...(parsed.sources ?? {}) },
    metrics: { ...base.metrics, ...(parsed.metrics ?? {}) },
    scoring: {
      ...base.scoring,
      ...(parsed.scoring ?? {}),
      priorityWeights: {
        ...base.scoring.priorityWeights,
        ...(parsed.scoring?.priorityWeights ?? {}),
      },
    },
    gate: { ...base.gate, ...(parsed.gate ?? {}) },
  };
}

export function renderHealthConfig(): string {
  return `${JSON.stringify(DEFAULT_HEALTH_CONFIG, null, 2)}\n`;
}

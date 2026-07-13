// RED tests for R0-01 (flow 009, W7 / T5, sub-slice S1).
//
// Pins the Release 0 STARTUP contract: the disabled capability floor, the
// enabled-startup preconditions (typed `environment_blocked`), and the
// offline guarantee, per `docs/requirements/keryx-project-agent-harness/
// acceptance.feature` `@task-R0-01` scenarios:
//   - @SC_R01_OFFLINE_START             "Start the offline harness without
//     another coding-agent runtime"
//   - @SC_R01_CAPABILITY_OFF_NO_LOAD    "Preserve the deterministic floor
//     when the harness is disabled"
//   - @SC_R02_TRUSTED_STARTUP           "Build trusted project context
//     before the first model request"
//   - @SC_R02_MISSING_PRECONDITION      "Reject startup when a required
//     provider precondition is missing"
//   - @SC_R02_CONTEXT_BOUND             "Persist context scope and
//     fingerprints"
//   - @SC_R02_OPTIONAL_ARTIFACT_DEGRADES (covered in ./context/manifest.test.ts)
//   - @SC_R14_NETWORK_OR_PROVIDER_ACCESS_DENIED "Keep Release 0 offline"
//   - @SC_R14_DETERMINISTIC_FLOOR       "Keep deterministic commands
//     independent of harness capability"
//
// T6 (impl, S1) implements `src/harness/config.ts` (`HarnessConfig`),
// `src/harness/startup.ts` (`startRun`, `StartupResult`), and
// `src/harness/types.ts` (`HarnessRunInput`) to make this suite GREEN; until
// then the missing-module import is the expected RED failure.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed, no `Date.now()`,
// `Math.random()`, or network. `globalThis.fetch` is monkey-patched to throw
// in every scenario that must prove "no provider request / no socket".
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../contracts/validator";
import { FakeProvider, type FakeProviderTranscript } from "./provider/fake-provider";

// PINNED API (see dispatch) — T6 exports these; imports fail until then
// (expected RED: "Cannot find module './config'" / './startup' / './types').
import type { HarnessConfig } from "./config";
import { type StartupResult, startRun } from "./startup";
import type { HarnessRunInput } from "./types";

// Frozen schemas dir, computed relative to this file (src/harness/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fixed id sequence. `makeDeps()` returns a
// *fresh* sequence starting from the same seed every call so two independent
// `startRun` invocations over identical input are byte-identical (no shared
// mutable counter leaking state between tests).
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// Config fixtures. `limits` fields mirror the "config" positive fixture in
// docs/requirements/keryx-project-agent-harness/schemas/fixtures/
// positive-contract-catalog.json (#/cases/config) so these objects are known
// schema-valid shapes, not invented ones.
// ---------------------------------------------------------------------------
const baseLimits = {
  maxRunSeconds: 60,
  maxConcurrentChildren: 1,
  maxToolOutputBytes: 1024,
  maxRetries: 0,
};

const disabledConfig: HarnessConfig = {
  schemaVersion: 1,
  enabled: false,
  defaultRole: "review",
  policyProfile: "read-only-review",
  limits: baseLimits,
};

// Enabled, but with NO defaultProvider/defaultModel — the run input must
// supply provider/model itself, or startup must block.
const enabledConfigNoDefaults: HarnessConfig = {
  schemaVersion: 1,
  enabled: true,
  defaultRole: "review",
  policyProfile: "read-only-review",
  limits: baseLimits,
};

// Enabled, with defaultProvider/defaultModel present — a run input that omits
// provider/model should resolve them from config and still start.
const enabledConfigWithDefaults: HarnessConfig = {
  schemaVersion: 1,
  enabled: true,
  defaultRole: "review",
  defaultProvider: "fake-provider",
  defaultModel: "fake-model-1",
  policyProfile: "read-only-review",
  limits: baseLimits,
};

// ---------------------------------------------------------------------------
// Run-input fixtures.
//
// NOTE (API delta — see subagent-result): `harness-run-input.schema.json` is
// frozen with `additionalProperties: false` and has NO `credentialRef`
// property, yet ADR-0001 / README §Startup and Resume Preconditions require a
// "reachable credential reference" as a startup precondition alongside
// provider/model/policy/role. `HarnessRunInput` (the local type S1 must
// define in `src/harness/types.ts`) is therefore modelled here as the frozen
// schema shape PLUS a local-only optional `credentialRef?: string` extension
// field that is never part of the schema-validated document. Positive schema
// validation below strips it via `toSchemaShape()` before validating.
// ---------------------------------------------------------------------------
type RunInputWithCredential = HarnessRunInput & { credentialRef?: string };

function toSchemaShape(input: RunInputWithCredential): Record<string, unknown> {
  const { credentialRef: _credentialRef, ...rest } = input;
  return rest;
}

const baseBudget = { maxSeconds: 1, maxToolCalls: 1, maxRetries: 0 };

// All five preconditions satisfied directly on the input (no config fallback
// needed). Mirrors the "run-input" positive fixture plus provider/model/
// credentialRef.
const fullRunInput: RunInputWithCredential = {
  schemaVersion: 1,
  request: "inspect",
  projectRoot: "/fixture",
  role: "review",
  policy: "read-only-review",
  budget: baseBudget,
  provider: "fake-provider",
  model: "fake-model-1",
  credentialRef: "env:FAKE_PROVIDER_API_KEY",
};

// Omits provider/model/credentialRef entirely but has credentialRef — used
// with `enabledConfigWithDefaults` to prove provider/model resolve from
// config defaults (SC_R01_OFFLINE_START / SC_R02_TRUSTED_STARTUP).
const runInputRelyingOnConfigDefaults: RunInputWithCredential = {
  schemaVersion: 1,
  request: "inspect",
  projectRoot: "/fixture",
  role: "review",
  policy: "read-only-review",
  budget: baseBudget,
  credentialRef: "env:FAKE_PROVIDER_API_KEY",
};

// Omits provider/model/credentialRef entirely — used with
// `enabledConfigNoDefaults` (which also has no defaults) to prove a genuinely
// missing precondition set is reported (SC_R02_MISSING_PRECONDITION).
const runInputMissingAll: RunInputWithCredential = {
  schemaVersion: 1,
  request: "inspect",
  projectRoot: "/fixture",
  role: "review",
  policy: "read-only-review",
  budget: baseBudget,
};

// Has provider/model directly but no credentialRef — isolates the
// "credential reference is missing" half of SC_R02_MISSING_PRECONDITION's
// Given clause.
const runInputMissingCredentialOnly: RunInputWithCredential = {
  schemaVersion: 1,
  request: "inspect",
  projectRoot: "/fixture",
  role: "review",
  policy: "read-only-review",
  budget: baseBudget,
  provider: "fake-provider",
  model: "fake-model-1",
};

function loadTranscript(file: string): FakeProviderTranscript {
  const raw = readFileSync(path.join(import.meta.dir, "provider", "fixtures", "transcripts", file), "utf8");
  return JSON.parse(raw) as FakeProviderTranscript;
}

// ---------------------------------------------------------------------------
// Offline guard helper: monkey-patches `globalThis.fetch` to throw for the
// duration of `fn`, then asserts it was never invoked. Every scenario that
// claims "no partial provider request" / "no socket opened" routes through
// this so the offline guarantee is mechanically enforced, not just implied.
// ---------------------------------------------------------------------------
function runOffline<T>(fn: () => T): T {
  const original = globalThis.fetch;
  let calls = 0;
  const blocked = (() => {
    calls += 1;
    throw new Error("network access attempted: fetch must not be called during startRun");
  }) as unknown as typeof fetch;
  globalThis.fetch = blocked;
  try {
    const result = fn();
    expect(calls).toBe(0);
    return result;
  } finally {
    globalThis.fetch = original;
  }
}

// --- Config fixtures validate against the frozen schema --------------------

describe("harness-config fixtures validate against harness-config.schema.json", () => {
  test("disabledConfig is schema-valid", () => {
    const result = validateAgainstSchema("harness-config.schema.json", disabledConfig, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("enabledConfigWithDefaults is schema-valid", () => {
    const result = validateAgainstSchema("harness-config.schema.json", enabledConfigWithDefaults, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("a fully-populated run input (minus the local-only credentialRef extension) validates against harness-run-input.schema.json", () => {
  test("fullRunInput schema shape is valid", () => {
    const result = validateAgainstSchema("harness-run-input.schema.json", toSchemaShape(fullRunInput), {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// --- 1. Disabled floor (SC_R01_CAPABILITY_OFF_NO_LOAD) ----------------------

describe("SC_R01_CAPABILITY_OFF_NO_LOAD — disabled capability floor", () => {
  test("config.enabled=false returns exactly {kind:'disabled'} with no manifest/startupEvent built, and never touches fetch", () => {
    const result = runOffline(() => startRun(fullRunInput, disabledConfig, makeDeps()));
    expect(result.kind).toBe("disabled");
    // Structural: nothing else was constructed — a 'disabled' result carries
    // no manifest, no startupEvent, no provider-shaped payload at all.
    expect(Object.keys(result)).toEqual(["kind"]);
  });

  test("the disabled result never varies with run-input/config detail (deterministic independence, SC_R14_DETERMINISTIC_FLOOR)", () => {
    const variantA = runOffline(() => startRun(fullRunInput, disabledConfig, makeDeps()));
    const variantB = runOffline(() => startRun(runInputMissingAll, disabledConfig, makeDeps()));
    const expected: StartupResult = { kind: "disabled" };
    expect(variantA).toEqual(expected);
    expect(variantB).toEqual(expected);
    expect(variantA).toEqual(variantB);
  });
});

// --- 2. Enabled offline start (SC_R01_OFFLINE_START, SC_R02_TRUSTED_STARTUP) -

describe("SC_R01_OFFLINE_START / SC_R02_TRUSTED_STARTUP — enabled offline start", () => {
  test("all preconditions satisfied directly on input returns {kind:'started'} with a bounded, schema-valid manifest and a startup event", () => {
    const result = runOffline(() => startRun(fullRunInput, enabledConfigNoDefaults, makeDeps()));
    expect(result.kind).toBe("started");
    if (result.kind !== "started") {
      throw new Error(`expected 'started', got '${result.kind}'`);
    }

    expect(result.manifest.projectRoot).toBe(fullRunInput.projectRoot);
    expect(result.manifest.contextHash).toMatch(/^[a-f0-9]{64}$/);

    const manifestValidation = validateAgainstSchema("harness-context-manifest.schema.json", result.manifest, {
      schemaDir: SCHEMA_DIR,
    });
    expect(manifestValidation.valid).toBe(true);
    expect(manifestValidation.errors).toEqual([]);

    // SC_R02_CONTEXT_BOUND: scope, project, policy, and schema fingerprints
    // are present. The manifest schema has no top-level `policy` property
    // (frozen — see subagent-result concerns), so the policy fingerprint is
    // expected on the startup event instead.
    expect(typeof result.startupEvent).toBe("object");
    expect(result.startupEvent).not.toBeNull();
    expect(result.startupEvent.contextHash).toBe(result.manifest.contextHash);
    expect(result.startupEvent.policyProfile ?? result.startupEvent.policy).toBe(fullRunInput.policy);
    expect(result.startupEvent.schemaVersion).toBe(1);
  });

  test("provider/model absent from input resolve from config defaults (enabledConfigWithDefaults) and startup still succeeds", () => {
    const result = runOffline(() => startRun(runInputRelyingOnConfigDefaults, enabledConfigWithDefaults, makeDeps()));
    expect(result.kind).toBe("started");
  });

  test("only the harness runtime and a FakeProvider are needed offline — constructing one from committed W6 fixtures requires no network", () => {
    // Proves "Keryx uses the harness runtime and fake provider only" is
    // achievable entirely offline alongside a 'started' startup result,
    // without startRun itself invoking any provider method (startRun has no
    // provider parameter — the model request happens after startup, in a
    // later run-loop out of this task's scope).
    const transcript = loadTranscript("finish-usage.json");
    const provider = runOffline(() => new FakeProvider([transcript]));
    expect(provider.describe().descriptor.providerId).toBe("fake-provider");
  });
});

// --- 3. Missing precondition (SC_R02_MISSING_PRECONDITION) ------------------

describe("SC_R02_MISSING_PRECONDITION — reject startup when a required provider precondition is missing", () => {
  test("provider, model, and credentialRef all missing (and not defaulted by config) blocks with a typed environment_blocked result", () => {
    const result = runOffline(() => startRun(runInputMissingAll, enabledConfigNoDefaults, makeDeps()));
    expect(result.kind).toBe("environment_blocked");
    if (result.kind !== "environment_blocked") {
      throw new Error(`expected 'environment_blocked', got '${result.kind}'`);
    }
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.missing).toContain("provider");
    expect(result.missing).toContain("model");
    expect(result.missing).toContain("credentialRef");
  });

  test("credential reference missing alone (provider/model present) blocks with missing=['credentialRef'] only", () => {
    const result = runOffline(() => startRun(runInputMissingCredentialOnly, enabledConfigNoDefaults, makeDeps()));
    expect(result.kind).toBe("environment_blocked");
    if (result.kind !== "environment_blocked") {
      throw new Error(`expected 'environment_blocked', got '${result.kind}'`);
    }
    expect(result.missing).toEqual(["credentialRef"]);
  });

  test("no partial provider request is made when startup is blocked (fetch never called)", () => {
    // runOffline() itself asserts zero fetch calls; this test exists to name
    // the scenario clause explicitly ("no partial provider request is made").
    const result = runOffline(() => startRun(runInputMissingAll, enabledConfigNoDefaults, makeDeps()));
    expect(result.kind).toBe("environment_blocked");
  });
});

// --- 4. Offline guarantee (SC_R14_NETWORK_OR_PROVIDER_ACCESS_DENIED) --------

describe("SC_R14_NETWORK_OR_PROVIDER_ACCESS_DENIED — keep Release 0 offline", () => {
  test("disabled, blocked, and started paths all complete with fetch never invoked", () => {
    let fetchCalls = 0;
    const original = globalThis.fetch;
    const blocked = (() => {
      fetchCalls += 1;
      throw new Error("fetch must not be called by startRun under any outcome");
    }) as unknown as typeof fetch;
    globalThis.fetch = blocked;
    try {
      startRun(fullRunInput, disabledConfig, makeDeps());
      startRun(runInputMissingAll, enabledConfigNoDefaults, makeDeps());
      startRun(fullRunInput, enabledConfigNoDefaults, makeDeps());
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchCalls).toBe(0);
  });
});

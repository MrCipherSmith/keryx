// AC7: the arbiter's model is a tier below the flagship, declared in config; GPT-6 Astra is refused by name.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArbiter } from "./arbiter";
import {
  ARBITER_TIERS,
  DEFAULT_ARBITER_TIER,
  DEFAULT_CALL_CAP,
  MAX_CALL_CAP,
  offlineCatalog,
  parseArbiterConfig,
  readArbiterConfig,
  resolveArbiterModel,
} from "./arbiter-config";
import { readArbiterLog } from "./arbiter-log";
import { ruleFollowingModel, type SeenTurns } from "./arbiter-test-support";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-arbiter-config-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(review: unknown): void {
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  writeFileSync(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ review }));
}

const OPUS = { providerId: "anthropic", modelId: "claude-opus-4-7" };
const CATALOG = [{ name: "anthropic", models: ["claude-opus-4-7", "claude-sonnet-5", "claude-haiku-4-5"] }];

test("without a config the arbiter is on, on the light tier, with a cap of 20 calls", () => {
  const config = parseArbiterConfig(undefined);
  expect(config).toMatchObject({ enabled: true, tier: "light", callCap: DEFAULT_CALL_CAP, errors: [] });
  expect(DEFAULT_ARBITER_TIER).toBe("light");
  expect(readArbiterConfig(root).errors).toEqual([]);
});

test("review.arbiter is read from tasks.config.json", () => {
  writeConfig({ arbiter: { enabled: false, tier: "standard", callCap: 5, timeoutMs: 3000, model: "openai/gpt-5-mini" } });
  expect(readArbiterConfig(root)).toMatchObject({
    enabled: false,
    tier: "standard",
    callCap: 5,
    timeoutMs: 3000,
    model: { providerId: "openai", modelId: "gpt-5-mini" },
    errors: [],
  });
});

test("the tier is a tier name: deep, a model id and a number are config errors", () => {
  expect([...ARBITER_TIERS]).toEqual(["light", "standard"]);
  for (const tier of ["deep", "claude-opus-4-7", 3, null]) {
    expect(parseArbiterConfig({ tier }).errors.join(" ")).toContain("review.arbiter.tier");
  }
});

test("a malformed block lists what is wrong", () => {
  expect(parseArbiterConfig("on").errors).toHaveLength(1);
  expect(parseArbiterConfig({ enabled: "yes" }).errors[0]).toContain("enabled");
  expect(parseArbiterConfig({ callCap: MAX_CALL_CAP + 1 }).errors[0]).toContain("callCap");
  expect(parseArbiterConfig({ callCap: 1.5 }).errors[0]).toContain("callCap");
  expect(parseArbiterConfig({ timeoutMs: 5 }).errors[0]).toContain("timeoutMs");
  expect(parseArbiterConfig({ model: "gpt" }).errors[0]).toContain("provider/model");
});

test("AC7: the light tier resolves to a model below the session's flagship", () => {
  const resolved = resolveArbiterModel(parseArbiterConfig({}), OPUS, { catalog: CATALOG });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.providerId).toBe("anthropic");
  expect(resolved.modelId).not.toBe(OPUS.modelId);
  expect(resolved.source).toBe("tier");
});

test("AC7: the offline catalog (no network) still resolves a tier on a curated provider", () => {
  const catalog = offlineCatalog(OPUS);
  expect(catalog[0]?.name).toBe("anthropic");
  expect(catalog[0]?.models).toContain(OPUS.modelId);
  const resolved = resolveArbiterModel(parseArbiterConfig({}), OPUS);
  expect(resolved.ok).toBe(true);
  if (resolved.ok) expect(resolved.modelId).not.toBe(OPUS.modelId);
});

test("a tier that finds nothing below the session keeps the session model and says so", () => {
  const only = [{ name: "anthropic", models: ["claude-opus-4-7"] }];
  const resolved = resolveArbiterModel(parseArbiterConfig({}), OPUS, { catalog: only });
  expect(resolved).toMatchObject({ ok: true, modelId: "claude-opus-4-7", source: "session-fallback" });
});

test("an unknown session model cannot resolve a tier", () => {
  expect(resolveArbiterModel(parseArbiterConfig({}), undefined, { catalog: CATALOG }).ok).toBe(false);
});

test("a pin wins over the tier", () => {
  const resolved = resolveArbiterModel(parseArbiterConfig({ model: "anthropic/claude-haiku-4-5" }), OPUS, { catalog: CATALOG });
  expect(resolved).toMatchObject({ ok: true, providerId: "anthropic", modelId: "claude-haiku-4-5", source: "pinned" });
});

test("AC7: GPT-6 Astra is refused by name as a pin", () => {
  for (const modelId of ["gpt-6-astra", "GPT-6-Astra", "gpt-6.1-astra", "openai/gpt-6-astra"]) {
    const resolved = resolveArbiterModel(parseArbiterConfig({ model: `openai/${modelId}` }), OPUS, { catalog: CATALOG });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("refused by name");
  }
});

test("AC7: GPT-6 Astra is refused when the session itself runs on it", () => {
  const session = { providerId: "openai", modelId: "gpt-6-astra" };
  const catalog = [{ name: "openai", models: ["gpt-6-astra"] }];
  const resolved = resolveArbiterModel(parseArbiterConfig({}), session, { catalog });
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) expect(resolved.error).toContain("refused by name");
});

test("AC7: a model other than Astra on the same provider is not refused", () => {
  const session = { providerId: "openai", modelId: "gpt-6-sol" };
  const resolved = resolveArbiterModel(parseArbiterConfig({ model: "openai/gpt-6-luna" }), session, { catalog: [{ name: "openai", models: ["gpt-6-sol", "gpt-6-luna"] }] });
  expect(resolved.ok).toBe(true);
});

test("AC7: a refused model is never called: the question escalates with model-refused", async () => {
  const seen: SeenTurns = { turns: [] };
  const log = path.join(root, "arbiter.log");
  const arbiter = createArbiter({
    cwd: root,
    runTurn: ruleFollowingModel(seen),
    session: () => OPUS,
    config: parseArbiterConfig({ model: "openai/gpt-6-astra" }),
    logFile: () => log,
    prices: () => ({}),
  });
  const decision = await arbiter.decide({
    question: "q",
    options: [
      { id: "a", label: "A", description: "", recommended: true },
      { id: "b", label: "B", description: "" },
    ],
    policy: { kind: "budget", facts: { budgetUsedPercent: 10, raisesBudget: false } },
  });
  expect(decision).toMatchObject({ verdict: "escalate", reason: "model-refused" });
  expect(seen.turns).toHaveLength(0);
  expect(readArbiterLog(log)[0]).toMatchObject({ reason: "model-refused" });
});

test("the model the arbiter used is on the log line, and it is not the session model", async () => {
  const log = path.join(root, "arbiter.log");
  const arbiter = createArbiter({
    cwd: root,
    runTurn: ruleFollowingModel(),
    session: () => OPUS,
    config: parseArbiterConfig({}),
    logFile: () => log,
    prices: () => ({}),
  });
  await arbiter.decide({
    question: "q",
    options: [
      { id: "a", label: "A", description: "", recommended: true },
      { id: "b", label: "B", description: "" },
    ],
    policy: { kind: "budget", facts: { budgetUsedPercent: 10, raisesBudget: false } },
  });
  const [entry] = readArbiterLog(log);
  expect(entry?.model).toMatch(/^anthropic\//);
  expect(entry?.model).not.toBe("anthropic/claude-opus-4-7");
  expect(entry?.modelSource).toBe("tier");
});

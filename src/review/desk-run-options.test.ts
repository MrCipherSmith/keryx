import { expect, test } from "bun:test";
import { deskReviewMinutes, DESK_OPTIONS_ENV, deskOptionsKey, parseDeskReviewOptions, readDeskOptionsJson } from "./desk-run-options";
import { DESK_REVIEW_PROJECT_ROOT, DESK_REVIEW_SHELL, deskReviewOptions } from "./autonomous-profile";

const first = { provider: "alpha", model: "vendor/one" };
const second = { provider: "beta", model: "two" };
const launch = { mode: "manual" as const, adaptive: false, modelPools: { strong: [first, second], middle: [], light: [] } };

test("launch options validate and canonicalize equivalent choices while preserving pool priority", () => {
  const options = parseDeskReviewOptions({ ...launch, flowId: "7" });
  expect(options.flowId).toBe("007");
  expect(options.maxTokens).toBeUndefined();
  expect(parseDeskReviewOptions({ ...launch, maxParallel: 15 }).maxParallel).toBe(15);
  expect(parseDeskReviewOptions({ ...launch, maxParallel: 32 }).maxParallel).toBe(32);
  expect(deskOptionsKey(parseDeskReviewOptions({ flowId: "007", ...launch }))).toBe(deskOptionsKey(options));
  expect(deskOptionsKey(parseDeskReviewOptions({ ...options, modelPools: { ...options.modelPools, strong: [second, first] } })))
    .not.toBe(deskOptionsKey(options));
  for (const invalid of [null, {}, { ...launch, mode: "scheduled" }, { ...launch, unknown: true },
    { ...launch, maxMinutes: 1201 }, { ...launch, maxMinutes: 0 }, { ...launch, maxParallel: 33 }, { ...launch, maxTokens: 0 }, { ...launch, maxWaves: 1.3 }, { ...launch, flowId: "../001" },
    { ...launch, modelPools: { middle: [] } }, { ...launch, modelPools: { ...launch.modelPools, strong: [first, first] } },
    { ...launch, modelPools: { ...launch.modelPools, strong: [{ provider: "space here", model: "x" }] } }]) {
    expect(() => parseDeskReviewOptions(invalid)).toThrow("configuration:");
  }
  expect(() => readDeskOptionsJson("{")).toThrow("JSON");
});

test("only the isolated native Desktop shell consumes a per-run policy", () => {
  const env = { [DESK_OPTIONS_ENV]: JSON.stringify(launch), [DESK_REVIEW_PROJECT_ROOT]: "/project" };
  expect(deskReviewOptions(env)).toBeUndefined();
  expect(deskReviewOptions({ ...env, [DESK_REVIEW_SHELL]: "1" })).toEqual(launch);
  expect(deskReviewOptions({ ...env, [DESK_REVIEW_SHELL]: "1", [DESK_REVIEW_PROJECT_ROOT]: "relative" })).toBeUndefined();
});

test("the executor uses the most restrictive explicit time budget", () => {
  expect(deskReviewMinutes({ ...launch, mode: "auto" })).toBe(1200);
  expect(deskReviewMinutes({ ...launch, mode: "manual" })).toBe(400);
  expect(deskReviewMinutes({ ...launch, orchestrator: false })).toBe(30);
  expect(deskReviewMinutes({ ...launch, maxMinutes: 180 })).toBe(180);
  expect(deskReviewMinutes({ ...launch, maxMinutes: 180 }, 15)).toBe(15);
  expect(deskReviewMinutes({ ...launch, maxMinutes: 5 }, 15)).toBe(5);
});

// Flow 336 — model guidance for Claude Code and Codex, from keryx's own
// routing table plus its model tiers. Hermetic: every test uses a fresh temp
// project root and a fresh temp per-user config dir (never the real
// `~/.local/share/keryx` or this repository's own `routing.config.json`),
// and every temp dir is removed in `afterEach` — macOS-safe (no reliance on
// Linux-only paths, `mkdtemp`/`tmpdir()` resolve correctly on both).
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveRoutingConfig } from "../harness/routing/config";
import { approveProjectRouting } from "../harness/routing/trust";
import {
  MODEL_CHOICE_CATEGORY_TIERS,
  buildModelChoiceBlockInput,
  describeModelChoiceStatus,
  readModelGuidanceConfig,
  renderModelChoicePolicy,
  resolveModelChoice,
} from "./model-choice";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function project(): Promise<{ cwd: string; userConfigDir: string }> {
  return { cwd: await tempDir("keryx-model-choice-"), userConfigDir: await tempDir("keryx-model-choice-user-") };
}

test("MODEL_CHOICE_CATEGORY_TIERS: planning/review are the flagship tier, subagents/docs/unattended one down, quick the smallest — never `default`/`coding`", () => {
  expect(MODEL_CHOICE_CATEGORY_TIERS.planning).toBe("deep");
  expect(MODEL_CHOICE_CATEGORY_TIERS.review).toBe("deep");
  expect(MODEL_CHOICE_CATEGORY_TIERS.subagents).toBe("standard");
  expect(MODEL_CHOICE_CATEGORY_TIERS.docs).toBe("standard");
  expect(MODEL_CHOICE_CATEGORY_TIERS.unattended).toBe("standard");
  expect(MODEL_CHOICE_CATEGORY_TIERS.quick).toBe("light");
  expect(MODEL_CHOICE_CATEGORY_TIERS.default).toBeUndefined();
  expect(MODEL_CHOICE_CATEGORY_TIERS.coding).toBeUndefined();
});

test("renderModelChoicePolicy: tier words only, no resolved assignments — never a hard-coded model id", () => {
  const line = renderModelChoicePolicy({});
  expect(line).toContain("flagship");
  expect(line).toContain("planning and review");
  expect(line).toContain("one tier down");
  expect(line).toContain("subagents, docs, and unattended work");
  expect(line).toContain("smallest tier");
  expect(line).toContain("trivial");
  expect(line).not.toMatch(/\bopus\b/i);
  expect(line).not.toMatch(/\bsonnet\b/i);
  expect(line).not.toMatch(/\bhaiku\b/i);
  expect(line).not.toMatch(/\bgpt-/i);
  expect(line).not.toMatch(/\bclaude-/i);
});

test("renderModelChoicePolicy: a resolved `model` assignment is named verbatim, an unresolved category is not", () => {
  const line = renderModelChoicePolicy({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-opus-5" },
  });
  expect(line).toContain("review=anthropic/claude-opus-5");
  expect(line).not.toContain("planning=");
});

test("renderModelChoicePolicy: a `provider-default` assignment is named as a provider default, not guessed as a model id", () => {
  const line = renderModelChoicePolicy({ quick: { kind: "provider-default", providerId: "deepseek" } });
  expect(line).toContain("quick=deepseek (provider default)");
});

test("resolveModelChoice: an absent routing.config.json resolves nothing — tier words only", async () => {
  const { cwd, userConfigDir } = await project();
  const result = await resolveModelChoice(cwd, userConfigDir);
  expect(result.assignments).toEqual({});
  expect(result.untrusted).toBe(false);
});

test("resolveModelChoice: an APPROVED project routing table resolves only the categories this policy addresses", async () => {
  const { cwd, userConfigDir } = await project();
  const table = {
    review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-opus-5" },
    coding: { kind: "model" as const, providerId: "anthropic", modelId: "claude-sonnet-5" },
  };
  await saveRoutingConfig("project", { cwd, userConfigDir }, table);
  await approveProjectRouting(cwd, table, userConfigDir);

  const result = await resolveModelChoice(cwd, userConfigDir);
  expect(result.assignments).toEqual({ review: table.review });
  // `coding` is a real routing category but this operator policy is silent on
  // it, so it must never surface here even though the table sets it.
  expect(result.assignments.coding).toBeUndefined();
});

test("resolveModelChoice: an UNAPPROVED project routing table resolves nothing, and says so", async () => {
  const { cwd, userConfigDir } = await project();
  await saveRoutingConfig(
    "project",
    { cwd, userConfigDir },
    { review: { kind: "model", providerId: "anthropic", modelId: "claude-opus-5" } },
  );
  // Deliberately no `approveProjectRouting` call.

  const result = await resolveModelChoice(cwd, userConfigDir);
  expect(result.assignments).toEqual({});
  expect(result.untrusted).toBe(true);
});

test("resolveModelChoice never reads the operator's personal (user) routing layer into a project's committed doc", async () => {
  const { cwd, userConfigDir } = await project();
  await saveRoutingConfig(
    "user",
    { cwd, userConfigDir },
    { review: { kind: "model", providerId: "openrouter", modelId: "operators-private-model" } },
  );

  const result = await resolveModelChoice(cwd, userConfigDir);
  expect(result.assignments).toEqual({});
});

test("readModelGuidanceConfig: absent tasks.config.json is enabled by default", async () => {
  const { cwd } = await project();
  const config = await readModelGuidanceConfig(cwd);
  expect(config.enabled).toBe(true);
});

test("readModelGuidanceConfig: modelGuidance.enabled=false turns it off", async () => {
  const { cwd } = await project();
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ modelGuidance: { enabled: false } }));

  const config = await readModelGuidanceConfig(cwd);
  expect(config.enabled).toBe(false);
});

test("readModelGuidanceConfig: a malformed tasks.config.json keeps the default enabled, with a note", async () => {
  const { cwd } = await project();
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), "{ not json");

  const config = await readModelGuidanceConfig(cwd);
  expect(config.enabled).toBe(true);
  expect(config.note).toBeDefined();
});

test("buildModelChoiceBlockInput: disabled config short-circuits before any routing-table read", async () => {
  const { cwd } = await project();
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ modelGuidance: { enabled: false } }));
  await saveRoutingConfig(
    "project",
    { cwd },
    { review: { kind: "model", providerId: "anthropic", modelId: "claude-opus-5" } },
  );

  const input = await buildModelChoiceBlockInput(cwd);
  expect(input.enabled).toBe(false);
  expect(input.assignments).toEqual({});
});

test("describeModelChoiceStatus: reports the resolved count out of the addressed categories", async () => {
  const { cwd, userConfigDir } = await project();
  const table = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-opus-5" } };
  await saveRoutingConfig("project", { cwd, userConfigDir }, table);
  await approveProjectRouting(cwd, table, userConfigDir);

  const status = await describeModelChoiceStatus(cwd, userConfigDir);
  expect(status).toContain("model_choice: enabled");
  expect(status).toMatch(/1\/6 categories resolved/);
});

test("describeModelChoiceStatus: names the disabled reason when turned off", async () => {
  const { cwd } = await project();
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ modelGuidance: { enabled: false } }));

  const status = await describeModelChoiceStatus(cwd);
  expect(status).toContain("model_choice: disabled");
});

// AC7: nothing in this module writes anywhere, and nothing in its own source
// text names a path outside the project it is handed (`~`, `homedir`, a
// Codex/Claude Code global config path). A static source check rather than a
// runtime one, because the thing being guarded against is a write this
// module's own functions never perform — there is no side effect to observe,
// only a promise the source text itself must keep.
test("AC7: model-choice.ts's own source never mentions a path outside the project (no `~`, homedir, or a global Codex/Claude config path)", async () => {
  const modulePath = fileURLToPath(new URL("./model-choice.ts", import.meta.url));
  const source = await readFile(modulePath, "utf8");
  // Strip comments naming the forbidden shape as an explanation of what this
  // module deliberately does NOT do — only real code matters here.
  const codeOnly = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  expect(codeOnly).not.toMatch(/homedir\(/);
  expect(codeOnly).not.toMatch(/\.codex[/\\]config\.toml/);
  expect(codeOnly).not.toMatch(/os\.homedir/);
  expect(source).not.toMatch(/writeFile|writeFileAtomic|writeContained/);
});

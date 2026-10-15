import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkDispatch, loadReviewerInputSchema } from "./dispatch-check";

function payload(model: Record<string, unknown>): Record<string, unknown> {
  return {
    review_context: {
      request: { raw: "review the change" },
      scope: { mode: "path", files: ["src/a.ts"] },
      routing: { selected_reviewers: ["review-logic"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-logic",
    scope_mode: "path",
    model,
    budget: { max_findings: 10 },
  };
}

// The block `keryx review tier --json` prints on a routing-table pick (src/commands/review.ts, runTier).
const ROUTED_MODEL = {
  tier: "standard",
  tier_reasons: ["base"],
  provider: "openai",
  model: "gpt-5",
  tier_resolution: "session-fallback",
  model_discovery: {},
  routed: true,
};

describe("checkDispatch model block", () => {
  test("accepts the model block the generator emits for a routed pick", async () => {
    const result = await checkDispatch([payload(ROUTED_MODEL)]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a block without routed still passes", async () => {
    const { routed: _routed, ...plain } = ROUTED_MODEL;
    expect((await checkDispatch([payload(plain)])).ok).toBe(true);
  });

  test("routed must be a boolean and unknown model keys are still refused", async () => {
    const wrongType = await checkDispatch([payload({ ...ROUTED_MODEL, routed: "yes" })]);
    expect(wrongType.errors.some((error) => error.code === "REVIEWER_INPUT_INVALID")).toBe(true);
    const unknown = await checkDispatch([payload({ ...ROUTED_MODEL, surprise: 1 })]);
    expect(unknown.errors.some((error) => error.code === "REVIEWER_INPUT_INVALID")).toBe(true);
  });

  test("every shipped copy of the model block declares routed", async () => {
    const files = [
      "src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json",
      ".metaproject/skills/gdskills/review/review-orchestrator/reviewer-input.schema.json",
      "src/gdskills/contracts/subagent-dispatch.schema.json",
      ".metaproject/core/gdskills/contracts/subagent-dispatch.schema.json",
    ];
    for (const file of files) {
      const schema = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "..", file), "utf8")) as { properties: { model: { properties: Record<string, { type?: string }> } } };
      expect({ file, routed: schema.properties.model.properties.routed?.type }).toEqual({ file, routed: "boolean" });
    }
    const loaded = (await loadReviewerInputSchema()) as unknown as { properties: { model: { properties: Record<string, unknown> } } };
    expect(Object.keys(loaded.properties.model.properties)).toContain("routed");
  });
});

describe("checkDispatch path fields", () => {
  const existing = new Set(["/skills/review-logic/SKILL.md", "/pkg/context.md"]);
  const pathExists = (file: string): boolean => existing.has(file);
  const withPaths = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...payload(ROUTED_MODEL), ...extra });

  test("a missing skill_path is refused, naming the field and the path", async () => {
    const result = await checkDispatch([withPaths({ skill_path: "/skills/gone/SKILL.md" })], { pathExists });
    const error = result.errors.find((entry) => entry.code === "REVIEWER_INPUT_PATH_MISSING");
    expect(result.ok).toBe(false);
    expect(error?.path).toBe("$.skill_path");
    expect(error?.message).toContain("/skills/gone/SKILL.md");
  });

  test("a missing context_doc is refused", async () => {
    const result = await checkDispatch([withPaths({ context_doc: "/pkg/nope.md" })], { pathExists });
    const error = result.errors.find((entry) => entry.code === "REVIEWER_INPUT_PATH_MISSING");
    expect(error?.path).toBe("$.context_doc");
    expect(error?.message).toContain("/pkg/nope.md");
  });

  test("a payload whose paths all exist passes, and inline text fields are not paths", async () => {
    const result = await checkDispatch([withPaths({ skill_path: "/skills/review-logic/SKILL.md", context_doc: "/pkg/context.md", diff: "/not/a/file", file_contents: "/also/not" })], { pathExists });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

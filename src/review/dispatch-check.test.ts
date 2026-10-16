import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildRunProfile, writeRunProfile } from "./run-profile";
import path from "node:path";
import { runLedger } from "../commands/review-ledger";
import { runDispatchCheck } from "../commands/review-slice";
import { writeActiveReview } from "./active-review";
import { checkDispatch, loadReviewerInputSchema } from "./dispatch-check";
import { CONFIRM_PLAN_TOOL, packagePlanGate, planConfirmationFor, writePlanConfirmation } from "./estimate";
import { narrowedSlices, packageRoutingRefusal, sliceTextReader } from "./routing-check";
import { parseScopedDiff, type SliceManifest } from "./slice";
import { routeSliceRegions } from "./slice-routing";

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

function manifestOf(count: number, waveBytes: number | undefined, maxBytes: number | undefined): SliceManifest {
  return {
    schemaVersion: 1,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(waveBytes === undefined ? {} : { waveBytes }),
    source: "diff",
    slices: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, path: `s${i}.diff`, bytes: 100, contentHash: `h${i}`, files: [`src/f${i}.ts`], domain: "src", split: "domain" as const })),
    omissions: [],
    totals: { slices: count, bytes: 100 * count, files: count, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
  } as SliceManifest;
}

const diffPayload = (slices: string[]): Record<string, unknown> => ({ ...payload(ROUTED_MODEL), scope_mode: "diff", slices });

describe("a manifest without sizes is refused", () => {
  test("neither waveBytes nor maxBytes: the check fails with a message instead of comparing against NaN", async () => {
    const result = await checkDispatch([diffPayload(["s0"])], { manifest: manifestOf(1, undefined, undefined) });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ code: "REVIEWER_INPUT_MANIFEST_UNSIZED" })]);
    expect(result.errors[0]!.message).toContain("neither waveBytes nor maxBytes");
  });

  test("an over-budget assignment against a sized manifest is still caught", async () => {
    const result = await checkDispatch([diffPayload(["s0", "s1", "s2"])], { manifest: manifestOf(3, 250, 200) });
    expect(result.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_TOO_LARGE"]);
  });
});

describe("an over-threshold plan is refused until the operator confirms it", () => {
  test("the plan refusal fails the check and names the card tool", async () => {
    const result = await checkDispatch([payload(ROUTED_MODEL)], { plan: { refusal: `over; call the ${CONFIRM_PLAN_TOOL} tool` } });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ code: "REVIEWER_INPUT_PLAN_UNCONFIRMED", reviewer: "plan" });
    expect((await checkDispatch([payload(ROUTED_MODEL)], { plan: { refusal: undefined } })).ok).toBe(true);
  });

  test("package plan gate and ledger build: refused over the threshold, accepted once confirmed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-plan-gate-"));
    const log = console.log;
    try {
      for (const name of ["review-orchestrator", "review-logic", "review-style", "review-clean-code", "review-architecture", "review-performance"]) {
        const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`);
      }
      await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills: {} } }));
      const pkg = path.join(root, ".metaproject", "reviews", "r1");
      await mkdir(path.join(pkg, "slices"), { recursive: true });
      await mkdir(path.join(pkg, "raw"), { recursive: true });
      await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ version: 1, files: [], changedLines: 10 }));
      const manifestPath = path.join(pkg, "slices", "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifestOf(10, 100, 100)));

      // Security review M9: a package started before flow 457 (no operator-gate stamp) is not held to the plan gate.
      const legacy = await packagePlanGate(pkg, { manifest: manifestPath });
      expect(legacy.estimate.overThreshold).toBe(true);
      expect(legacy.refusal).toBeUndefined();
      await writeRunProfile(pkg, buildRunProfile({ env: {} }));

      const gate = await packagePlanGate(pkg, { manifest: manifestPath });
      expect(gate.estimate.dispatches).toBe(50);
      expect(gate.refusal).toContain(CONFIRM_PLAN_TOOL);
      expect(gate.refusal).toContain("--confirm --quote");
      await expect(runLedger(["build", pkg, "--package", pkg, "--dry-run"], { rejectUnknownFlags: () => {} })).rejects.toThrow(`ledger build refused: the review plan is over the operator threshold`);

      await writePlanConfirmation(pkg, planConfirmationFor(gate.estimate, "fifty is fine", "tui-card"));
      expect((await packagePlanGate(pkg, { manifest: manifestPath })).refusal).toBeUndefined();
      console.log = () => {};
      await runLedger(["build", pkg, "--package", pkg, "--dry-run"], { rejectUnknownFlags: () => {} });
      process.exitCode = 0;

      // Security review M4: the wave budget is part of the plan; a re-slice with another --host needs the operator again.
      await writeFile(manifestPath, JSON.stringify(manifestOf(10, 50, 50)));
      const rebudgeted = await packagePlanGate(pkg, { manifest: manifestPath });
      expect(rebudgeted.estimate.planKey).not.toBe(gate.estimate.planKey);
      expect(rebudgeted.refusal).toContain(CONFIRM_PLAN_TOOL);

      await writeFile(manifestPath, JSON.stringify(manifestOf(2, undefined, undefined)));
      await expect(runLedger(["build", pkg, "--package", pkg, "--dry-run"], { rejectUnknownFlags: () => {} })).rejects.toThrow("neither waveBytes nor maxBytes");
    } finally {
      console.log = log;
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function gatedPackage(): Promise<{ root: string; pkg: string; manifestPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-plan-gate-"));
  for (const name of ["review-orchestrator", "review-logic", "review-style", "review-clean-code", "review-architecture", "review-performance"]) {
    const dir = path.join(root, ".metaproject", "skills", "gdskills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`);
  }
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills: {} } }));
  const pkg = path.join(root, ".metaproject", "reviews", "r1");
  await mkdir(path.join(pkg, "slices"), { recursive: true });
  await mkdir(path.join(pkg, "raw"), { recursive: true });
  await mkdir(path.join(pkg, "drivers"), { recursive: true });
  await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ version: 1, files: [], changedLines: 10 }));
  await writeRunProfile(pkg, buildRunProfile({ env: {} }));
  return { root, pkg, manifestPath: path.join(pkg, "slices", "manifest.json") };
}

function oneSliceManifest(entry: Record<string, unknown>): SliceManifest {
  return {
    schemaVersion: 1,
    maxBytes: 100_000,
    waveBytes: 100_000,
    source: "diff",
    slices: [{ id: "s0", path: "s0.diff", bytes: 100, files: [], domain: "src", split: "domain", ...entry }],
    omissions: [],
    totals: { slices: 1, bytes: 100, files: 1, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
  } as SliceManifest;
}

const fileDiff = (file: string, lines: string[]): string => `--- ${file}\n@@ 1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;

describe("security review M3: slice routing is recomputed from the slice text", () => {
  test("a hand-edited manifest (review-logic only, light) on src/auth/login.ts is refused by ledger build and complete's check", async () => {
    const { root, pkg, manifestPath } = await gatedPackage();
    try {
      await writeFile(path.join(pkg, "slices", "s0.diff"), fileDiff("src/auth/login.ts", ["export function login(user: string, password: string) {", "  return checkPassword(user, password);", "}"]));
      await writeFile(manifestPath, JSON.stringify(oneSliceManifest({ files: ["src/auth/login.ts"], roles: ["review-logic"], depth: "light" })));
      const { narrowed } = narrowedSlices(JSON.parse(readFileSync(manifestPath, "utf8")) as SliceManifest, sliceTextReader(path.dirname(manifestPath)));
      expect(narrowed).toHaveLength(1);
      expect(narrowed[0]!.depth).toEqual({ recorded: "light", needed: "deep" });
      expect(narrowed[0]!.missingRoles).toContain("review-security-code");
      await expect(runLedger(["build", pkg, "--package", pkg, "--dry-run"], { rejectUnknownFlags: () => {} })).rejects.toThrow("narrower than their content needs");
      expect(packageRoutingRefusal(pkg, root)).toContain("s0: roles");
      // Routed as wide as the content needs (or wider): accepted.
      const needed = routeSliceRegions("s0", parseScopedDiff(readFileSync(path.join(pkg, "slices", "s0.diff"), "utf8")), {});
      await writeFile(manifestPath, JSON.stringify(oneSliceManifest({ files: ["src/auth/login.ts"], roles: needed.roles, depth: needed.depth })));
      expect(packageRoutingRefusal(pkg, root)).toBeUndefined();
    } finally {
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("security review M5: ledger build escalates, and a grown plan says why it needs the operator again", () => {
  test("a major finding on a light docs slice re-opens it deep in ledger build; the old confirmation no longer covers the plan", async () => {
    const { root, pkg, manifestPath } = await gatedPackage();
    const log = console.log;
    const error = console.error;
    try {
      await writeFile(path.join(root, "routing.config.json"), JSON.stringify({ reviewPlan: { maxDispatches: 1 } }));
      const text = fileDiff("docs/guide.md", ["Step one: read the guide.", "Step two: run it."]);
      await writeFile(path.join(pkg, "slices", "s0.diff"), text);
      const routed = routeSliceRegions("s0", parseScopedDiff(text), {});
      expect(routed.depth).toBe("light");
      await writeFile(manifestPath, JSON.stringify(oneSliceManifest({ files: ["docs/guide.md"], roles: routed.roles, depth: "light" })));
      const before = await packagePlanGate(pkg, { manifest: manifestPath });
      expect(before.refusal).toContain(CONFIRM_PLAN_TOOL);
      await writePlanConfirmation(pkg, planConfirmationFor(before.estimate, "go ahead", "tui-card"));
      expect((await packagePlanGate(pkg, { manifest: manifestPath })).refusal).toBeUndefined();
      await writeFile(path.join(pkg, "drivers", "review-logic-1.json"), JSON.stringify({ reviewer: "review-logic", slices: ["s0"], result: "raw/review-logic.txt" }));
      await writeFile(path.join(pkg, "raw", "review-logic.txt"), `REVIEW_RESULT: ${JSON.stringify({ reviewer: "review-logic", status: "DONE", slices: ["s0"], findings: [{ id: "F-1", severity: "major", file: "docs/guide.md", problem: "wrong step" }] })}\n`);
      console.log = () => {};
      console.error = () => {};
      await expect(runLedger(["build", pkg, "--package", pkg], { rejectUnknownFlags: () => {} })).rejects.toThrow("the plan grew because 1 light slice(s) (s0) were re-opened deep");
      const escalated = (JSON.parse(readFileSync(manifestPath, "utf8")) as SliceManifest).slices[0]!;
      expect(escalated.depth).toBe("deep");
      expect(escalated.escalated).toEqual({ by: "review-logic", finding: "F-1" });
    } finally {
      console.log = log;
      console.error = error;
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("security review minor: dispatch-check finds the package for its plan gate", () => {
  test("without --package the manifest's own package is gated; with an open package and a shared manifest the check refuses", async () => {
    const { root, pkg, manifestPath } = await gatedPackage();
    const cwd = process.cwd();
    const log = console.log;
    const error = console.error;
    const out: string[] = [];
    try {
      process.chdir(root);
      await writeFile(path.join(root, "routing.config.json"), JSON.stringify({ reviewPlan: { maxDispatches: 1 } }));
      await writeFile(path.join(pkg, "manifest.json"), JSON.stringify({ reviewId: "r1", status: "draft" }));
      await writeFile(manifestPath, JSON.stringify(manifestOf(10, 100, 100)));
      await writeFile(path.join(root, "payload.json"), JSON.stringify([payload(ROUTED_MODEL)]));
      console.log = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
      console.error = () => {};
      await runDispatchCheck(["--payload", "payload.json", "--manifest", path.relative(root, manifestPath), "--json"], { rejectUnknownFlags: () => {} });
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).toContain("REVIEWER_INPUT_PLAN_UNCONFIRMED");
      process.exitCode = 0;

      const shared = path.join(root, ".metaproject", "data", "review", "slices");
      await mkdir(shared, { recursive: true });
      await writeFile(path.join(shared, "manifest.json"), JSON.stringify(manifestOf(10, 100, 100)));
      await writeActiveReview(root, { id: "r1", dir: pkg });
      await expect(runDispatchCheck(["--payload", "payload.json", "--manifest", ".metaproject/data/review/slices/manifest.json"], { rejectUnknownFlags: () => {} })).rejects.toThrow("dispatch-check needs --package");
    } finally {
      process.chdir(cwd);
      console.log = log;
      console.error = error;
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });
});

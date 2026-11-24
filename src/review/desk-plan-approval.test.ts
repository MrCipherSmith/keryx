import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createLayersFixture } from "./layers.test-helpers";
import { refreshLayers } from "./layers";
import path from "node:path";
import { installLocalPlanRestrictions, requestPlanApproval } from "./desk-run-executor";
import { estimatePlan } from "./plan-confirmation";
import { prepareDesktopDispatch } from "../commands/review-plan-desktop";
import { writeWaveDrivers } from "./wave-drivers";
import type { SliceManifest } from "./slice";
import type { ReviewPlan } from "../commands/review-plan";
import type { AutonomousSummary } from "./autonomous-summary";

const ref = "https://github.com/a/b/pull/1";
const summary = { rounds: 1, tokens: 5 } as AutonomousSummary;

test("large Desktop plans respect mode, budget and current PR on every authorization", async () => {
  const fixture = await createLayersFixture();
  const root = fixture.root;
  const { first: base, second: head } = fixture;
  try {
    const pkg = path.join(root, ".metaproject", "reviews", "r1");
    await mkdir(path.join(pkg, "slices"), { recursive: true });
    for (const role of ["review-logic", "review-style", "review-clean-code"]) {
      const skill = path.join(root, ".metaproject", "skills", "gdskills", "review", role);
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), `---\nname: ${role}\ndescription: fixture\n---\n`);
    }
    await writeFile(path.join(pkg, "round-roles.json"), JSON.stringify({ enabled: ["review-style", "review-clean-code"] }));
    await writeFile(path.join(pkg, "manifest.json"), JSON.stringify({ reviewId: "r1", status: "draft", target: { kind: "pr", ref, base, head } }));
    await writeFile(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"], changedLines: 1000 }));
    const slices = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, path: `s${i}.diff`, bytes: 100, files: ["src/a.ts"], domain: "src", split: "file" }));
    await writeFile(path.join(pkg, "slices", "manifest.json"), JSON.stringify({ schemaVersion: 1, maxBytes: 100, waveBytes: 100, source: "diff", slices, omissions: [], totals: {} }));
    const estimate = await estimatePlan(pkg, 10);
    expect(estimate.dispatches).toBeGreaterThan(160);
    expect(estimate.overThreshold).toBe(true);
    await writeFile(path.join(pkg, "plan.json"), JSON.stringify({ planKey: estimate.planKey, overThreshold: true, next: "confirm plan" }));
    const controller = new AbortController();
    const common = { cwd: root, repo: "a/b", number: 1, baseSha: base, headSha: head, runDir: root,
      signal: controller.signal, onProgress: () => {} };
    const modelPools = { strong: [], middle: [], light: [] };
    const auto = { ...common, options: { mode: "auto" as const, adaptive: false, maxParallel: 10, modelPools } };
    const manual = { ...common, options: { ...auto.options, mode: "manual" as const } };
    expect((await requestPlanApproval(pkg, root, ref, manual, summary, async () => true))?.approved).toBe(false);
    expect((await requestPlanApproval(pkg, root, ref, auto, summary, async () => false))?.approved).toBe(false);
    expect((await requestPlanApproval(pkg, root, ref, auto, summary, async () => true))?.approved).toBe(true);
    expect(JSON.parse(await readFile(path.join(pkg, "plan-confirmation.json"), "utf8")).confirmedVia).toBe("auto-policy");
    const sliceManifest = JSON.parse(await readFile(path.join(pkg, "slices", "manifest.json"), "utf8")) as SliceManifest;
    await Promise.all(slices.map(slice => writeFile(path.join(pkg, "slices", slice.path), "diff --git a/src/a.ts b/src/a.ts\n+changed\n")));
    await writeFile(path.join(pkg, "pr-context.md"), "PR context");
    await refreshLayers({ projectRoot: root, packageDir: pkg });
    await writeFile(path.join(root, ".keryx-review-context.json"), JSON.stringify({ pr: { url: ref, headSha: head, baseSha: base, state: "OPEN" }, flows: [] }));
    const plan = { package: pkg, target: { kind: "pr", ref, base, head }, round: { number: 1, range: { base, head }, priorFindings: 0 },
      roster: estimate.perRole.map(item => item.role), dispatches: estimate.dispatches } as ReviewPlan;
    const drivers = await writeWaveDrivers({ packageDir: pkg, manifest: sliceManifest, sliceDir: path.join(pkg, "slices"), reviewers: plan.roster });
    const context = { schemaVersion: 1 as const, repo: "a/b", number: 1, headSha: head, collectedAt: "", round: 1,
      intent: { round: 1, title: "Fixture", body: "" }, ci: { state: "none" as const, checks: [], failing: [] }, comments: [], backendPins: [] };
    const queue = await prepareDesktopDispatch(root, plan, base, sliceManifest, drivers, context, async args => ({
      stdout: args[0] === "tier" ? JSON.stringify({ model: { tier: "standard", inherit: true, dispatchable: true } }) : "", stderr: "", exitCode: 0,
    }), auto.options);
    const prepared = JSON.parse(await readFile(path.join(root, queue), "utf8"));
    expect(prepared.blocked).toEqual([]);
    expect(prepared.calls).toHaveLength(estimate.dispatches);
    expect((await requestPlanApproval(pkg, root, ref, auto, summary, async () => false))?.approved).toBe(false);
    expect((await requestPlanApproval(pkg, root, ref, { ...auto, budgetMinutes: 1 }, summary, async () => true))?.approved).toBe(false);
    expect((await requestPlanApproval(pkg, root, ref, manual, summary, async () => true))?.approved).toBe(false);
    // A finding can grow an authorized light plan; the new manifest gets a separate decision.
    const grown = [...slices, { ...slices[0]!, id: "grown", path: "grown.diff", escalated: { by: "review-logic", finding: "F-1" } }];
    await writeFile(path.join(pkg, "slices", "manifest.json"), JSON.stringify({ schemaVersion: 1, maxBytes: 100, waveBytes: 100, source: "diff", slices: grown, omissions: [], totals: {} }));
    const expanded = await requestPlanApproval(pkg, root, ref, auto, summary, async () => true);
    expect(expanded?.approved).toBe(true);
    expect(expanded?.planKey).not.toBe(estimate.planKey);
    const records = await (await import("node:fs/promises")).readdir(path.join(pkg, "plan-confirmations"));
    expect(records.length).toBe(2);
    const tooManyGroups = Array.from({ length: 101 }, (_, i) => ({ ...slices[0]!, id: `x${i}`, path: `x${i}.diff` }));
    await writeFile(path.join(pkg, "slices", "manifest.json"), JSON.stringify({ schemaVersion: 1, maxBytes: 100, waveBytes: 100, source: "diff", slices: tooManyGroups, omissions: [], totals: {} }));
    const unfit = await estimatePlan(pkg, 10);
    await writeFile(path.join(pkg, "plan.json"), JSON.stringify({ planKey: unfit.planKey, overThreshold: true, next: "confirm plan" }));
    const denied = await requestPlanApproval(pkg, root, ref, auto, summary, async () => true);
    expect(denied?.approved).toBe(false);
    expect(denied?.reason).toMatch(/native wave admission limits/i);
    expect((await (await import("node:fs/promises")).readdir(path.join(pkg, "plan-confirmations"))).length).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("isolated checkout takes only locally edited restrictive review settings", async () => {
  const fixture = await createLayersFixture();
  const target = path.join(fixture.root, "isolated");
  try {
    await mkdir(target);
    await writeFile(path.join(target, "routing.config.json"), JSON.stringify({ model: "trusted", reviewPlan: { maxDispatches: 100, autoApprove: true } }));
    await writeFile(path.join(fixture.root, "routing.config.json"), JSON.stringify({ model: "untrusted", reviewPlan: { maxDispatches: 40, autoApprove: false, autoMaxMinutes: 300 } }));
    await installLocalPlanRestrictions(fixture.root, target, new AbortController().signal);
    const merged = JSON.parse(await readFile(path.join(target, "routing.config.json"), "utf8"));
    expect(merged).toEqual({ model: "trusted", reviewPlan: { maxDispatches: 40, autoApprove: false, autoMaxMinutes: 300 } });
  } finally { await fixture.cleanup(); }
});

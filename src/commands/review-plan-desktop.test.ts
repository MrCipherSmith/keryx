import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { refreshLayers } from "../review/layers";
import { createLayersFixture, git } from "../review/layers.test-helpers";
import { createPinnedSourceInput, prepareBlastInput } from "./review-plan-desktop-context";
import { SUBAGENT_CONTEXT_FILES_MAX_BYTES, SUBAGENT_CONTEXT_FILES_MAX_COUNT } from "../lib/subagent-context";
import path from "node:path";
import type { PrContext } from "../review/context-collect";
import { checkDispatch } from "../review/dispatch-check";
import { PR_CONTEXT_FILE } from "../review/pr-context";
import type { SliceEntry, SliceManifest } from "../review/slice";
import { writeWaveDrivers } from "../review/wave-drivers";
import { resolveReviewWave } from "../review/wave-key";
import type { PlanDeps, ReviewPlan } from "./review-plan";
import { desktopPassAllocator, prepareDesktopDispatch } from "./review-plan-desktop";

let root: string, dir: string;
beforeEach(async () => {
  const fixture = await createLayersFixture();
  root = fixture.root;
  dir = fixture.packageDir;
  await refreshLayers({ projectRoot: root, packageDir: dir });
  mkdirSync(path.join(dir, "slices"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = "1".repeat(40), head = "2".repeat(40);
const ref = "https://github.com/example/project/pull/3";
const role = "review-team";
const definition = `.metaproject/project-skills/review/${role}/SKILL.md`;
const context: PrContext = { schemaVersion: 1, repo: "example/project", number: 3, headSha: head, collectedAt: "",
  round: 2, intent: { round: 1, title: "Test", body: "" }, ci: { state: "none", checks: [], failing: [] }, comments: [], backendPins: [] };
const model = { tier: "standard", tier_reasons: ["base:standard"], inherit: true, tier_resolution: "session-fallback",
  model_discovery: { provider: "", candidates: [], ranked: [], session_rank: null, fallback_reason: "test session" } };
function slice(id: string, bytes: number, kind: NonNullable<SliceEntry["kind"]>): SliceEntry {
  return { id, bytes, kind, path: id + ".diff", domain: "source", files: ["src/a.ts"], split: "file", roles: [role], depth: "light",
    ...(kind === "fix" ? { findingIds: ["F-001"] } : {}) };
}
function manifestOf(slices: SliceEntry[]): SliceManifest {
  return { schemaVersion: 1, maxBytes: 8000, waveBytes: 8000, source: "diff", slices, omissions: [],
    totals: { slices: slices.length, bytes: slices.reduce((n, s) => n + s.bytes, 0), files: 1, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 } };
}
function record(name: string, value: unknown) { writeFileSync(path.join(dir, name), JSON.stringify(value)); }

test("fix, new and second-look drivers prepare their own validated contracts and bounded model sizes", async () => {
  const head = git(root, ["rev-parse", "HEAD"]);
  const pinned = readFileSync(path.join(root, "src/a.ts"), "utf8");
  writeFileSync(path.join(root, "src/a.ts"), "working copy differs");
  const slices = [slice("slice-01", 6500, "fix"), slice("slice-02", 1000, "new"), slice("slice-03", 4000, "second-look")];
  slices[0]!.files.push("src/removed.ts");
  const manifest = manifestOf(slices);
  const finding = { id: "F-001", reviewer: role, severity: "major", problem: "Unexpected fallback", impact: "Wrong value",
    suggested_fix: "Handle missing input", evidence: "fixture assertion", confidence: "high", class_scope: { sites: ["src/a.ts:1"], enumeration_method: "Read the local consumers" } };
  record("manifest.json", {}); record("slices/manifest.json", manifest); record("prior_findings.json", [{ id: finding.id, finding }]);
  record("scope-files.json", { files: ["src/a.ts"], changedLines: 100000 });
  writeFileSync(path.join(root, PR_CONTEXT_FILE), JSON.stringify({ pr: { url: ref, headSha: head, baseSha: base, state: "OPEN" }, flows: [] }));
  writeFileSync(path.join(dir, "pr-context.md"), "PR");
  mkdirSync(path.dirname(path.join(root, definition)), { recursive: true });
  writeFileSync(path.join(root, definition), "---\nname: review-team\ndescription: test reviewer\nmodel_tier: light\n---\nReview");
  const plan: ReviewPlan = { v: 1, package: dir, target: { kind: "pr", ref, base, head },
    round: { number: 2, mode: "delta", previous: "previous", source: "local-package", range: { base: "3".repeat(40), head }, fixHunks: 1, newHunks: 1, priorFindings: 1, carried: 0, line: "" },
    slices: { fix: [], new: [] }, roster: [role, "review-style"], dispatches: 3, minutes: { min: 1, max: 2 },
    overThreshold: false, overReasons: [], planKey: "key", warnings: [], next: "dispatch" };
  const drivers = await writeWaveDrivers({ packageDir: dir, manifest, sliceDir: path.join(dir, "slices"), reviewers: plan.roster });
  const requirements: number[] = [];
  let maxContext = Infinity;
  const payloads: Array<{ is_fix_round: boolean; skill_path: string; prior_findings?: unknown[]; metaproject: { graph: unknown };
    review_context: { git: { base: string }; pr: { base: string }; scope: { pinned_sources?: Array<{ path: string; attachment: string }> }; token_policy: { omissions: string[] } } }> = [];
  for (const s of slices) writeFileSync(path.join(dir, "slices", s.path), "x".repeat(s.bytes));
  const run: PlanDeps["run"] = async args => {
    if (args[0] === "tier") {
      const tokens = Number(args[args.indexOf("--input-tokens") + 1]);
      requirements.push(tokens);
      return { stdout: JSON.stringify({ model: { ...model, dispatchable: tokens <= maxContext } }), stderr: "", exitCode: 0 };
    }
    expect(args[0]).toBe("dispatch-check");
    const payload = JSON.parse(readFileSync(path.join(root, args[args.indexOf("--payload") + 1]!), "utf8"));
    const exists = (file: string) => existsSync(path.join(root, file));
    const checked = await checkDispatch([payload], { manifest, pathExists: exists, prContext: { exists } });
    expect(checked.errors).toEqual([]);
    payloads.push(payload);
    return { stdout: "", stderr: "", exitCode: checked.ok ? 0 : 1 };
  };
  const prContext = { ...context, headSha: head };
  const queueFile = await prepareDesktopDispatch(root, plan, base, manifest, drivers, prContext, run);
  const queue = JSON.parse(readFileSync(path.join(root, queueFile), "utf8"));
  expect(queue.blocked).toEqual([]);
  expect(queue.routedOut).toEqual(["review-style"]);
  expect(queue.calls).toHaveLength(3);
  const fix = payloads.find(p => p.is_fix_round)!;
  expect(fix.skill_path).toBe(definition);
  expect(fix.review_context.git.base).toBe("3".repeat(40));
  expect(fix.review_context.pr.base).toBe(base);
  expect(fix.prior_findings).toEqual([{ round: 1, finding, claimed_disposition: "unreported" }]);
  expect(fix.metaproject.graph).toBeDefined();
  const source = fix.review_context.scope.pinned_sources?.find(file => file.path === "src/a.ts");
  expect(source).toBeDefined();
  expect(readFileSync(path.join(root, source!.attachment), "utf8")).toBe(pinned);
  expect(queue.calls[0].context_files).toContain(source!.attachment);
  expect(fix.review_context.token_policy.omissions).toContain("Pinned source src/removed.ts: no regular file at review head.");
  expect(payloads.filter(p => !p.is_fix_round && !p.prior_findings)).toHaveLength(2);
  expect(new Set(requirements).size).toBe(3);
  expect(Math.max(...requirements)).toBeLessThan(4000);

  const missing = "review-extra";
  const blockedDriver = path.join(dir, "drivers", missing + "-w1.json");
  writeFileSync(blockedDriver, JSON.stringify({ reviewer: missing, slices: [], slicePaths: [], result: `raw/${missing}-w1.txt` }));
  const retry = await prepareDesktopDispatch(root, { ...plan, roster: [...plan.roster, missing], dispatches: 4 }, base, manifest,
    [...drivers, blockedDriver], prContext, run);
  const partial = JSON.parse(readFileSync(path.join(root, retry), "utf8"));
  expect(partial.calls).toHaveLength(3);
  expect(partial.blocked).toMatchObject([{ reviewer: missing, driver: missing + "-w1.json" }]);
  expect(partial.routedOut).toEqual(["review-style"]);

  const launch = { mode: "manual" as const, adaptive: false, maxWaves: 1, modelPools: { light: [], middle: [], strong: [] } };
  const tiers: string[] = [];
  const capture: PlanDeps["run"] = async args => {
    if (args[0] === "tier") tiers.push(args[args.indexOf("--desk-tier") + 1]!);
    return run(args);
  };
  const limitedFile = await prepareDesktopDispatch(root, plan, base, manifest, drivers, prContext, capture, launch);
  const limited = JSON.parse(readFileSync(path.join(root, limitedFile), "utf8"));
  expect(limited.calls).toHaveLength(1);
  expect(limited.blocked.map((item: { reason: string }) => item.reason)).toEqual(Array(2).fill("Excluded by the configured limit of 1 reviewer waves."));
  expect(tiers).toEqual(["light"]);
  expect(limited.modelRouting).toMatchObject([{ tier: "light", tierReason: "Fixed routing uses the reviewer skill’s declared tier." }]);
  tiers.length = 0;
  await prepareDesktopDispatch(root, plan, base, manifest, drivers, prContext, capture, { ...launch, adaptive: true });
  expect(tiers).toEqual(["standard"]); // repeated fix raises the small-scope tier
  tiers.length = 0;
  slices[2]!.risk = { score: 0.9, why: ["high-risk scope"] };
  const mixed = await prepareDesktopDispatch(root, plan, base, manifest, drivers, prContext, capture, { ...launch, adaptive: true, maxWaves: 3 });
  expect([...tiers].sort()).toEqual(["deep", "light", "standard"]);
  expect(JSON.parse(readFileSync(path.join(root, mixed), "utf8")).modelRouting).toEqual(expect.arrayContaining([
    expect.objectContaining({ tier: "middle", slices: ["slice-01"] }),
    expect.objectContaining({ tier: "light", slices: ["slice-02"] }),
    expect.objectContaining({ tier: "strong", slices: ["slice-03"] }),
  ]));


  maxContext = requirements[0]! - 1;
  const smaller = await prepareDesktopDispatch(root, plan, base, manifest, [drivers[0]!], prContext, run);
  const compact = JSON.parse(readFileSync(path.join(root, smaller), "utf8"));
  expect(compact.calls[0].context_files).toEqual(queue.calls[0].context_files.slice(0, -1));
  expect(payloads.at(-1)?.review_context.token_policy.omissions).toContain("Pinned source src/a.ts: model routing refused the larger context.");
});

test("a 33-call plan uses original slice waves that the host admits and refuses an exhausted wave", async () => {
  const slices = [slice("slice-01", 6000, "new"), slice("slice-02", 6000, "new")];
  const manifest = manifestOf(slices);
  record("manifest.json", {}); record("slices/manifest.json", manifest);
  const allocate = desktopPassAllocator(manifest);
  const passes = Array.from({ length: 32 }, () => allocate(["slice-01"]));
  passes.push(allocate(["slice-02"]));
  expect(new Set(passes).size).toBe(2);
  for (const pass of new Set(passes)) expect((await resolveReviewWave(root, { package: path.relative(root, dir), pass })).ok).toBe(true);
  expect(() => allocate(["slice-01"])).toThrow("admission limits");
});

test("Desktop admits 100 native passes and refuses opening another in the same plan", () => {
  const slices = Array.from({ length: 101 }, (_, index) => slice(`slice-${index}`, 6000, "new"));
  const allocate = desktopPassAllocator(manifestOf(slices));
  const admitted = slices.slice(0, 100).map(entry => allocate([entry.id]));
  expect(new Set(admitted).size).toBe(100);
  expect(() => allocate([slices[100]!.id])).toThrow("admission limits");
  expect(allocate([slices[0]!.id])).toBe(admitted[0]!);
});

test("scope B materializes unchanged callers at the reviewed head in the read-only child's context", async () => {
  const head = git(root, ["rev-parse", "HEAD"]);
  const caller = "src/b.ts";
  const pinned = readFileSync(path.join(root, caller), "utf8");
  writeFileSync(path.join(root, caller), "working copy differs");
  record("blast-radius.json", { files: [{ file: caller, via: "src/a.ts" }] });
  const diff = slice("slice-01", 17, "new");
  writeFileSync(path.join(dir, "slices", diff.path), "diff from the PR");
  const input = await prepareBlastInput(root, dir, head, manifestOf([diff]));
  expect(input.files).toEqual([caller]);
  expect(input.attachments.map(file => readFileSync(path.join(root, file), "utf8"))).toEqual(["diff from the PR", pinned]);
  expect(input.bytes).toBe(Buffer.byteLength("diff from the PR" + pinned));
});

test("pinned source context preserves diff attachments when blob text does not fit or is excluded", async () => {
  writeFileSync(path.join(root, "src", "large.ts"), " ".repeat(321));
  writeFileSync(path.join(root, ".env.fixture"), "fixture source excluded from provider attachments");
  writeFileSync(path.join(root, "src", "binary"), Buffer.from([0, 1, 2]));
  symlinkSync("a.ts", path.join(root, "src", "link"));
  git(root, ["add", "--force", "--", "src/large.ts", ".env.fixture", "src/binary", "src/link"]);
  git(root, ["commit", "-m", "attachment fixture"]);
  const read = createPinnedSourceInput(root, dir, git(root, ["rev-parse", "HEAD"]));
  const diff = [".metaproject/slice.diff"];
  const result = await read(["src/large.ts", ".env.fixture", "src/binary", "src/link", "src/a.ts"],
    diff, SUBAGENT_CONTEXT_FILES_MAX_BYTES - 320);
  expect(result.attachments[0]).toBe(diff[0]!);
  expect(result.sources.map(source => source.path)).toEqual(["src/a.ts"]);
  expect(result.omissions).toEqual([
    "Pinned source src/large.ts: does not fit the attachment budget.",
    "Pinned source .env.fixture: path is excluded from attachments.",
    "Pinned source src/binary: not UTF-8 source text.",
    "Pinned source src/link: no regular file at review head.",
  ]);
  const full = Array.from({ length: SUBAGENT_CONTEXT_FILES_MAX_COUNT }, (_, i) => `diff-${i}`);
  expect(await read(["src/a.ts"], full, 0)).toEqual({
    sources: [], bytes: 0, attachments: full, omissions: ["Pinned source src/a.ts: attachment budget exhausted."],
  });
});

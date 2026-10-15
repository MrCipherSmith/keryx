// Flow 441 AC8/AC9: the path flags of the review commands that name a file refuse a path outside the project
// root, before anything is read or written, and the path they open is the one that was judged.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REVIEW_CONFINED_PATH_FLAGS, REVIEW_NON_PATH_FLAGS, confinedPathFlags, reviewPathFlagRefusal } from "../lib/review-path-flags";
import { CHUNKS_FLAGS, COVERAGE_FLAGS } from "./review-chunks";
import { ESTIMATE_FLAGS, REQUIRED_FLAGS, VERDICT_FLAGS } from "./review";
import { LAYERS_BLOCK_FLAGS, LAYERS_REFRESH_FLAGS, LAYERS_STATUS_FLAGS } from "./review-layers";
import {
  DISPATCH_CHECK_FLAGS,
  RETRY_PLAN_FLAGS,
  SLICE_FLAGS,
  type SliceDeps,
  runDispatchCheck,
  runRetryPlan,
  runSlice,
} from "./review-slice";

const DIFF = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const deps: SliceDeps = {
  gitDiff: async () => DIFF,
  readDiffSource: async () => DIFF,
  parseContextLines: () => 3,
  rejectUnknownFlags: () => {},
};

const PAYLOAD = {
  review_context: {
    request: { raw: "review the change" },
    scope: { mode: "diff", files: ["src/a.ts"] },
    routing: { selected_reviewers: ["review-logic"] },
    token_policy: { context_mode: "light", omissions: [] },
  },
  reviewer: "review-logic",
  scope_mode: "diff",
  model: { tier: "standard", tier_reasons: ["base"], tier_resolution: "session-fallback", model_discovery: {}, inherit: true },
  budget: { max_findings: 10 },
  slices: ["slice-01"],
};

let originalCwd: string;
let originalExitCode: typeof process.exitCode;
let dir: string;
let outside: string;
let escaped: string;

function real(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  dir = real("keryx-slice-paths-");
  outside = real("keryx-slice-outside-");
  escaped = path.join(path.dirname(dir), `${path.basename(dir)}-escaped`);
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, ".metaproject"));
  process.chdir(dir);
});

const originalStdin = Bun.stdin;
const feedStdin = (text: () => Promise<string>): void => {
  (Bun as unknown as { stdin: unknown }).stdin = { text };
};

afterEach(() => {
  (Bun as unknown as { stdin: unknown }).stdin = originalStdin;
  process.chdir(originalCwd);
  process.exitCode = originalExitCode ?? 0;
  for (const tmp of [dir, outside, escaped]) rmSync(tmp, { recursive: true, force: true });
});

const quietly = async (run: () => Promise<void>): Promise<string> => {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
};

test("AC8: review slice --out outside the project exits with a named reason and writes nothing", async () => {
  const target = path.join(outside, "slices");
  await expect(runSlice(["--out", target], deps)).rejects.toThrow(/keryx review slice --out: .*outside the project root/);
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(outside)).toEqual([]);

  await expect(runSlice(["--out", "../escaped"], deps)).rejects.toThrow(/outside the project root/);
  expect(existsSync(path.join(dir, "..", "escaped"))).toBe(false);
  await expect(runSlice(["--out", `../${path.basename(escaped)}`], deps)).rejects.toThrow(/outside the project root/);
  expect(existsSync(escaped)).toBe(false);
});

test("AC8: review slice --out inside the project, under .metaproject/reviews/ and the default directory still work", async () => {
  await quietly(() => runSlice(["--out", "out/slices"], deps));
  expect(existsSync(path.join(dir, "out", "slices", "manifest.json"))).toBe(true);

  await quietly(() => runSlice(["--out", ".metaproject/reviews/r1/slices"], deps));
  expect(existsSync(path.join(dir, ".metaproject", "reviews", "r1", "slices", "manifest.json"))).toBe(true);

  await quietly(() => runSlice([], deps));
  expect(existsSync(path.join(dir, ".metaproject", "data", "review", "slices", "manifest.json"))).toBe(true);
});

test("AC8: review slice --out through a symlink inside the project that points outside is refused", async () => {
  symlinkSync(outside, path.join(dir, "escape"));
  await expect(runSlice(["--out", "escape/slices"], deps)).rejects.toThrow(/outside the project root/);
  await expect(runSlice(["--out=escape"], deps)).rejects.toThrow(/outside the project root/);
  expect(readdirSync(outside)).toEqual([]);
});

test("F-002: a .metaproject that is a symlink to outside the project is not an allowed root", async () => {
  rmSync(path.join(dir, ".metaproject"), { recursive: true });
  symlinkSync(outside, path.join(dir, ".metaproject"));
  await expect(runSlice(["--out", ".metaproject/reviews/r1"], deps)).rejects.toThrow(/outside the project root/);
  await expect(runSlice([], deps)).rejects.toThrow(/outside the project root/);
  expect(readdirSync(outside)).toEqual([]);
});

test("F-011: a directory swapped for a symlink to outside while the diff is fetched is not written through", async () => {
  const swapping: SliceDeps = {
    ...deps,
    gitDiff: async () => {
      symlinkSync(outside, path.join(dir, "swap"));
      return DIFF;
    },
  };
  await expect(runSlice(["--out", "swap/slices"], swapping)).rejects.toThrow(/outside the project root/);
  expect(readdirSync(outside)).toEqual([]);
});

test("F-013: a command run from a subdirectory resolves its flags against that directory, and the default state lands beside the manifest", async () => {
  mkdirSync(path.join(dir, "sub"));
  process.chdir(path.join(dir, "sub"));
  await quietly(() => runSlice(["--out", "../out/slices"], deps));
  const manifest = path.join(dir, "out", "slices", "manifest.json");
  expect(existsSync(manifest)).toBe(true);
  await expect(runSlice(["--out", "../../elsewhere"], deps)).rejects.toThrow(/outside the project root/);

  await quietly(() => runRetryPlan(["--manifest", "../out/slices/manifest.json", "--next-wave", "--reviewer", "review-logic"], deps));
  expect(existsSync(path.join(dir, "out", "slices", "retry-state.json"))).toBe(true);
  expect(existsSync(path.join(dir, "sub", "retry-state.json"))).toBe(false);
});

test("F-005: dispatch-check and retry-plan, given paths inside the project, run and report", async () => {
  await quietly(() => runSlice(["--out", "slices"], deps));
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, JSON.stringify(PAYLOAD));

  const checked = await quietly(() => runDispatchCheck(["--payload", payload, "--manifest", "slices/manifest.json", "--json"], deps));
  expect(JSON.parse(checked).ok).toBe(true);
  expect(process.exitCode ?? 0).toBe(0);

  const planned = await quietly(() =>
    runRetryPlan(["--manifest", "slices/manifest.json", "--next-wave", "--reviewer", "review-logic", "--json"], deps),
  );
  expect(JSON.parse(planned).reviewer).toBe("review-logic");
  expect(existsSync(path.join(dir, "slices", "retry-state.json"))).toBe(true);

  const state = path.join(dir, ".metaproject", "retry.json");
  await quietly(() =>
    runRetryPlan(["--manifest", "slices/manifest.json", "--next-wave", "--reviewer", "review-logic", "--state", state], deps),
  );
  expect(existsSync(state)).toBe(true);
});

test("AC9: review retry-plan --manifest outside the project is refused", async () => {
  const manifest = path.join(outside, "manifest.json");
  writeFileSync(manifest, "{}");
  await expect(runRetryPlan(["--manifest", manifest, "--next-wave"], deps)).rejects.toThrow(/retry-plan --manifest: .*outside the project root/);
});

test("AC9: review retry-plan --state outside the project is refused", async () => {
  const manifest = path.join(dir, "manifest.json");
  writeFileSync(manifest, "{}");
  const state = path.join(outside, "retry-state.json");
  await expect(runRetryPlan(["--manifest", manifest, "--next-wave", "--state", state], deps)).rejects.toThrow(/retry-plan --state: .*outside the project root/);
  expect(existsSync(state)).toBe(false);
});

test("AC9: review dispatch-check --manifest outside the project is refused", async () => {
  const manifest = path.join(outside, "manifest.json");
  writeFileSync(manifest, "{}");
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, "{}");
  await expect(runDispatchCheck(["--payload", payload, "--manifest", manifest], deps)).rejects.toThrow(/dispatch-check --manifest: .*outside the project root/);
});

test("AC9: a manifest that is a symlink to a file outside the project is refused", async () => {
  const target = path.join(outside, "manifest.json");
  writeFileSync(target, "{}");
  symlinkSync(target, path.join(dir, "manifest.json"));
  await expect(runRetryPlan(["--manifest", "manifest.json", "--next-wave"], deps)).rejects.toThrow(/outside the project root/);
});

test("F-010: the diff source is opened by the path that was judged, and standard input stays standard input", async () => {
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "inside-link"));
  writeFileSync(path.join(dir, "real", "d.diff"), DIFF);
  const sources: string[] = [];
  const spying: SliceDeps = {
    ...deps,
    readDiffSource: async (source) => {
      sources.push(source);
      return DIFF;
    },
  };
  await quietly(() => runSlice(["--diff", "inside-link/d.diff", "--out", "o1"], spying));
  await quietly(() => runSlice(["--diff", "-", "--out", "o2"], spying));
  expect(sources).toEqual([path.join(dir, "real", "d.diff"), "-"]);
});

test("F-010: --diff, --result and --payload outside the project are refused, and a model-bound diff is never read", async () => {
  const secret = path.join(outside, "secret.txt");
  writeFileSync(secret, "secret");
  const manifest = path.join(dir, "manifest.json");
  writeFileSync(manifest, "{}");
  let read = false;
  const spying: SliceDeps = {
    ...deps,
    readDiffSource: async () => {
      read = true;
      return DIFF;
    },
  };
  await expect(runSlice(["--diff", secret], spying)).rejects.toThrow(/slice --diff: .*outside the project root/);
  expect(read).toBe(false);
  await expect(runRetryPlan(["--manifest", manifest, "--result", secret], deps)).rejects.toThrow(/retry-plan --result: .*outside the project root/);
  await expect(runDispatchCheck(["--payload", secret], deps)).rejects.toThrow(/dispatch-check --payload: .*outside the project root/);
});

test("F-003: a path that goes through a symlink and back (link/../m.json) is read where it was judged, not where the kernel would take it", async () => {
  await quietly(() => runSlice(["--out", "slices"], deps));
  symlinkSync(outside, path.join(dir, "link"));
  mkdirSync(path.join(outside, "slices"));
  writeFileSync(path.join(outside, "slices", "manifest.json"), "not json");
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, JSON.stringify(PAYLOAD));

  const checked = await quietly(() => runDispatchCheck(["--payload", payload, "--manifest", "link/../slices/manifest.json", "--json"], deps));
  expect(JSON.parse(checked).ok).toBe(true);
});

test("guard: every flag of a review command is sorted into confined or non-path, and the two lists name no flag the command lacks", () => {
  const commands: Record<string, readonly string[]> = {
    slice: SLICE_FLAGS,
    "dispatch-check": DISPATCH_CHECK_FLAGS,
    "retry-plan": RETRY_PLAN_FLAGS,
    layers: [...new Set([...LAYERS_REFRESH_FLAGS, ...LAYERS_STATUS_FLAGS, ...LAYERS_BLOCK_FLAGS])],
    chunks: CHUNKS_FLAGS,
    coverage: COVERAGE_FLAGS,
    required: REQUIRED_FLAGS,
    estimate: ESTIMATE_FLAGS,
    verdict: VERDICT_FLAGS,
  };
  expect(Object.keys(REVIEW_CONFINED_PATH_FLAGS).sort()).toEqual(Object.keys(commands).sort());
  expect(Object.keys(REVIEW_NON_PATH_FLAGS).sort()).toEqual(Object.keys(commands).sort());
  for (const [command, flags] of Object.entries(commands)) {
    const confined = confinedPathFlags(command);
    const nonPath = REVIEW_NON_PATH_FLAGS[command] as readonly string[];
    expect({ command, unsorted: flags.filter((flag) => !confined.includes(flag) && !nonPath.includes(flag)) }).toEqual({ command, unsorted: [] });
    expect({ command, both: confined.filter((flag) => nonPath.includes(flag)) }).toEqual({ command, both: [] });
    expect({ command, unknown: [...confined, ...nonPath].filter((flag) => !flags.includes(flag)) }).toEqual({ command, unknown: [] });
  }
});

test("AC9: the same flags stay usable inside the project", async () => {
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, "{}");
  const manifest = path.join(dir, ".metaproject", "reviews", "manifest.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ slices: [] }));
  const out = await quietly(() => runDispatchCheck(["--payload", payload, "--manifest", manifest, "--json"], deps));
  expect(JSON.parse(out).ok).toBe(false);
  expect(process.exitCode).toBe(1);
});

test("reviewPathFlagRefusal: the rule the commands and the trust table share", () => {
  const where = { projectRoot: dir, cwd: dir };
  expect(reviewPathFlagRefusal("slice", ["--out", "a/b"], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("slice", ["--out=.metaproject/reviews/x"], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("slice", [], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("slice", ["--out", outside], where)).toMatch(/outside the project root/);
  expect(reviewPathFlagRefusal("slice", [`--out=${outside}`], where)).toMatch(/outside the project root/);
  expect(reviewPathFlagRefusal("slice", ["--diff", outside], where)).toMatch(/--diff/);
  expect(reviewPathFlagRefusal("slice", ["--diff", "-"], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("retry-plan", ["--manifest", "m.json", "--state", outside], where)).toMatch(/--state/);
  expect(reviewPathFlagRefusal("retry-plan", ["--result", outside], where)).toMatch(/--result/);
  expect(reviewPathFlagRefusal("dispatch-check", ["--manifest", outside], where)).toMatch(/--manifest/);
  expect(reviewPathFlagRefusal("dispatch-check", ["--payload", outside], where)).toMatch(/--payload/);
  expect(reviewPathFlagRefusal("status", ["--out", outside], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("constructor", ["--out", outside], where)).toBeUndefined();
  expect(reviewPathFlagRefusal("__proto__", ["--out", outside], where)).toBeUndefined();
});

test("Flow 441 F-036: a --state directory swapped for a symlink to outside while --result is read from stdin is not written through", async () => {
  await quietly(() => runSlice(["--out", "slices"], deps));
  feedStdin(async () => {
    symlinkSync(outside, path.join(dir, "swap"));
    return JSON.stringify({ reviewer: "review-logic", status: "complete", summary: "s", findings: [] });
  });
  await expect(
    runRetryPlan(["--manifest", "slices/manifest.json", "--result", "-", "--next-wave", "--state", "swap/state.json"], deps),
  ).rejects.toThrow(/outside the project root/);
  expect(readdirSync(outside)).toEqual([]);
});

test("Flow 441 F-037: --payload - and --result - read standard input", async () => {
  await quietly(() => runSlice(["--out", "slices"], deps));
  feedStdin(async () => JSON.stringify(PAYLOAD));
  const checked = await quietly(() => runDispatchCheck(["--payload", "-", "--manifest", "slices/manifest.json", "--json"], deps));
  expect(JSON.parse(checked).ok).toBe(true);
  expect(existsSync(path.join(dir, "-"))).toBe(false);

  feedStdin(async () => JSON.stringify({ reviewer: "review-logic", status: "complete", summary: "s", findings: [] }));
  const planned = await quietly(() => runRetryPlan(["--manifest", "slices/manifest.json", "--result", "-", "--next-wave", "--json"], deps));
  expect(JSON.parse(planned).reviewer).toBe("review-logic");
});

test("Flow 441 F-037: an --out given twice, the second time outside the project, is refused even though the first is inside", async () => {
  await expect(runSlice(["--out", "ok", `--out=${path.join(outside, "x")}`], deps)).rejects.toThrow(/outside the project root/);
  expect(readdirSync(outside)).toEqual([]);
});

test("Flow 441 F-038: link/../x is read where it was judged for --payload, --result and a retry-plan --manifest", async () => {
  await quietly(() => runSlice(["--out", "slices"], deps));
  symlinkSync(outside, path.join(dir, "link"));
  writeFileSync(path.join(dir, "payload.json"), JSON.stringify(PAYLOAD));
  writeFileSync(path.join(dir, "result.json"), JSON.stringify({ reviewer: "review-logic", status: "complete", summary: "s", findings: [] }));
  writeFileSync(path.join(outside, "payload.json"), "not json");
  writeFileSync(path.join(outside, "result.json"), "not json");
  const checked = await quietly(() => runDispatchCheck(["--payload", "link/../payload.json", "--manifest", "slices/manifest.json", "--json"], deps));
  expect(JSON.parse(checked).ok).toBe(true);
  const planned = await quietly(() =>
    runRetryPlan(["--manifest", "link/../slices/manifest.json", "--result", "link/../result.json", "--next-wave", "--json"], deps),
  );
  expect(JSON.parse(planned).reviewer).toBe("review-logic");
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultBundledSourceRoot, loadBundledManifest, type InstallManifest } from "./manifest";
import { planInstall } from "./plan";
import type { CapabilityMatrixDocument } from "../../integrations/matrix";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-install-plan-"));
  await mkdir(path.join(root, "rules"), { recursive: true });
  await writeFile(path.join(root, "rules", "a.mdc"), "---\npaths: [\"**/*.x\"]\n---\nrule a\n", "utf8");
  await mkdir(path.join(root, "src", "gdskills", "bundled", "skills", "review", "fake-skill"), { recursive: true });
  await writeFile(
    path.join(root, "src", "gdskills", "bundled", "skills", "review", "fake-skill", "SKILL.md"),
    "---\nname: fake-skill\ndescription: fixture\n---\nbody\n",
    "utf8",
  );
  // A second, distinctly-named skill directory so `skill-b` and `skill-c`
  // (both members of `lang:x`) resolve to different destinations — two
  // modules sharing one destination is a collision the planner now rejects.
  await mkdir(path.join(root, "src", "gdskills", "bundled", "skills", "review", "fake-skill-c"), { recursive: true });
  await writeFile(
    path.join(root, "src", "gdskills", "bundled", "skills", "review", "fake-skill-c", "SKILL.md"),
    "---\nname: fake-skill-c\ndescription: fixture\n---\nbody\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FIXTURE_MANIFEST: InstallManifest = {
  schemaVersion: "1.0.0",
  profiles: {
    base: { description: "base", modules: ["rule-a"], components: ["lang:x"], stackDetectionAware: true },
    depcheck: { description: "dep", modules: [], components: ["lang:x"], stackDetectionAware: false },
    withhook: { description: "hook", modules: ["hook-a"], components: [] },
  },
  modules: {
    "rule-a": {
      kind: "rule",
      description: "rule a",
      paths: ["rules/a.mdc"],
      targets: ["claude", "keryx-shell"],
      dependencies: [],
      defaultInstall: true,
      cost: "light",
      stability: "stable",
    },
    "skill-b": {
      kind: "skill",
      description: "skill b",
      paths: ["src/gdskills/bundled/skills/review/fake-skill/**"],
      targets: ["claude", "keryx-shell"],
      dependencies: ["rule-a"],
      defaultInstall: true,
      cost: "light",
      stability: "stable",
    },
    "skill-c": {
      kind: "skill",
      description: "skill c, opt-in only",
      paths: ["src/gdskills/bundled/skills/review/fake-skill-c/**"],
      targets: ["claude", "keryx-shell"],
      dependencies: ["rule-a"],
      defaultInstall: false,
      cost: "light",
      stability: "stable",
    },
    "hook-a": {
      kind: "hook-runtime",
      description: "hook a",
      paths: ["rules/a.mdc"],
      targets: ["keryx-shell"],
      dependencies: [],
      defaultInstall: true,
      cost: "light",
      stability: "stable",
    },
  },
  components: {
    "lang:x": {
      family: "language",
      modules: ["skill-b", "skill-c"],
      detectionMarkers: ["x"],
      provenance: { origin: "authored" },
    },
  },
};

const UNSUPPORTED_MATRIX: CapabilityMatrixDocument = {
  version: "0.0.0",
  generatedAt: "2026-01-01T00:00:00Z",
  harnesses: [
    {
      id: "keryx-shell",
      label: "Keryx shell",
      state: "unsupported",
      adapterKind: "host-hook",
      confidence: "experimental",
      surfaces_supported: [],
      surfaces_unsupported: [],
      install_command: "",
      verification_command: "",
      risk_notes: "fixture",
      last_verified: "2026-01-01",
      source_docs: [],
    },
  ],
};

test("plan is byte-identical across two runs with identical inputs (W1-AC6)", async () => {
  const input = {
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude" as const,
    repoRoot: root,
    stack: { tags: { x: true }, uncertain: false },
  };
  const first = await planInstall(input);
  const second = await planInstall(input);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  expect(first.ok).toBe(true);
  const moduleIds = first.modules.map((m) => m.id);
  expect(new Set(moduleIds).size).toBe(moduleIds.length);
  expect(moduleIds).toContain("rule-a");
  expect(moduleIds).toContain("skill-b");
});

test("stack-detection-aware component: detected tag includes it", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude",
    repoRoot: root,
    stack: { tags: { x: true }, uncertain: false },
  });
  const component = plan.components.find((c) => c.id === "lang:x");
  expect(component?.included).toBe(true);
  expect(component?.reason).toContain("detected via tag");
});

test("stack-detection-aware component: tag present and false excludes it", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude",
    repoRoot: root,
    stack: { tags: { x: false }, uncertain: false },
  });
  const component = plan.components.find((c) => c.id === "lang:x");
  expect(component?.included).toBe(false);
  expect(plan.modules.map((m) => m.id)).not.toContain("skill-b");
});

test("stack-detection-aware component: missing tag or uncertain detection fails open", async () => {
  const missingTag = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude",
    repoRoot: root,
    stack: { tags: {}, uncertain: false },
  });
  expect(missingTag.components.find((c) => c.id === "lang:x")?.included).toBe(true);
  expect(missingTag.components.find((c) => c.id === "lang:x")?.reason).toContain("missing from stack.json");

  const noStack = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude",
    repoRoot: root,
  });
  expect(noStack.components.find((c) => c.id === "lang:x")?.included).toBe(true);
  expect(noStack.stackInput.source).toBe("none");
  expect(noStack.stackInput.uncertain).toBe(true);

  const uncertain = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude",
    repoRoot: root,
    stack: { tags: { x: false }, uncertain: true },
  });
  expect(uncertain.components.find((c) => c.id === "lang:x")?.included).toBe(true);
});

test("--with forces a non-default module and pulls in its dependency; --without excludes it again", async () => {
  const withPlan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "depcheck",
    target: "claude",
    repoRoot: root,
    with: ["skill-c"],
  });
  expect(withPlan.ok).toBe(true);
  const ids = withPlan.modules.map((m) => m.id);
  expect(ids).toContain("skill-c");
  expect(ids).toContain("rule-a"); // dependency closure

  const withoutPlan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "depcheck",
    target: "claude",
    repoRoot: root,
    with: ["skill-c"],
    without: ["skill-c"],
  });
  expect(withoutPlan.modules.map((m) => m.id)).not.toContain("skill-c");
});

test("a module with defaultInstall:false is not installed merely because its component is included", async () => {
  const plan = await planInstall({ manifest: FIXTURE_MANIFEST, profileId: "depcheck", target: "claude", repoRoot: root });
  expect(plan.modules.map((m) => m.id)).not.toContain("skill-c");
});

test("a hook-runtime module whose target the capability matrix marks unsupported fails the plan with a named reason (W1-AC5)", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "withhook",
    target: "keryx-shell",
    repoRoot: root,
    matrix: UNSUPPORTED_MATRIX,
  });
  expect(plan.ok).toBe(false);
  expect(plan.errors.some((e) => e.includes("hook-a") && e.includes("W1-AC5"))).toBe(true);
});

test("F4: a hook-runtime module's matrix check covers EVERY declared target, not only the install target", async () => {
  // hook-a's own `targets` is only ["keryx-shell"] in FIXTURE_MANIFEST; build a
  // manifest where a hook-runtime module also names a second, unsupported
  // target, and plan for a DIFFERENT target than either — the matrix defect
  // (checking only the requested install target) would miss this entirely.
  const manifest: InstallManifest = {
    ...FIXTURE_MANIFEST,
    profiles: {
      ...FIXTURE_MANIFEST.profiles,
      withhook2: { description: "hook2", modules: ["hook-multi"], components: [] },
    },
    modules: {
      ...FIXTURE_MANIFEST.modules,
      "hook-multi": {
        kind: "hook-runtime",
        description: "hook multi-target",
        paths: ["rules/a.mdc"],
        targets: ["claude", "keryx-shell"],
        dependencies: [],
        defaultInstall: true,
        cost: "light",
        stability: "stable",
      },
    },
  };
  const plan = await planInstall({
    manifest,
    profileId: "withhook2",
    target: "claude",
    repoRoot: root,
    matrix: UNSUPPORTED_MATRIX, // only declares keryx-shell, and marks it "unsupported"
  });
  expect(plan.ok).toBe(false);
  expect(
    plan.errors.some((e) => e.includes("hook-multi") && e.includes("keryx-shell") && e.includes("W1-AC5")),
  ).toBe(true);
});

test("F3: an unrecognised target fails the plan by name instead of resolving to an ok, empty plan", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "../../victim" as unknown as Parameters<typeof planInstall>[0]["target"],
    repoRoot: root,
  });
  expect(plan.ok).toBe(false);
  expect(plan.modules).toEqual([]);
  expect(plan.errors.some((e) => e.includes("unknown target"))).toBe(true);
});

test("F3: a recognised harness id with no v1 destination table entry fails the plan by name", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "codex",
    repoRoot: root,
  });
  expect(plan.ok).toBe(false);
  expect(plan.errors.some((e) => e.includes("codex") && e.includes("no destination table"))).toBe(true);
});

test("F15: an unknown --with/--without id fails the plan by name instead of being silently ignored", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "base",
    target: "claude",
    repoRoot: root,
    with: ["does-not-exist"],
    without: ["also-not-real"],
  });
  expect(plan.ok).toBe(false);
  expect(plan.errors.some((e) => e.includes("does-not-exist") && e.includes("--with"))).toBe(true);
  expect(plan.errors.some((e) => e.includes("also-not-real") && e.includes("--without"))).toBe(true);
});

test("F15: --without a dependency of an otherwise-selected module fails the plan naming the dependency chain", async () => {
  const plan = await planInstall({
    manifest: FIXTURE_MANIFEST,
    profileId: "depcheck",
    target: "claude",
    repoRoot: root,
    with: ["skill-c"], // pulls in rule-a as a dependency
    without: ["rule-a"], // then tries to drop the dependency itself
  });
  expect(plan.ok).toBe(false);
  expect(plan.errors.some((e) => e.includes("rule-a") && e.includes("skill-c"))).toBe(true);
});

test("a module whose paths resolve to zero files fails the plan with a named reason", async () => {
  const manifest: InstallManifest = {
    ...FIXTURE_MANIFEST,
    profiles: {
      empty: { description: "empty", modules: ["ghost"], components: [] },
    },
    modules: {
      ...FIXTURE_MANIFEST.modules,
      ghost: {
        kind: "rule",
        description: "ghost",
        paths: ["nowhere/does-not-exist.mdc"],
        targets: ["claude"],
        dependencies: [],
        defaultInstall: true,
        cost: "light",
        stability: "experimental",
      },
    },
  };
  const plan = await planInstall({ manifest, profileId: "empty", target: "claude", repoRoot: root });
  expect(plan.ok).toBe(false);
  expect(plan.errors.some((e) => e.includes("ghost") && e.includes("zero files"))).toBe(true);
});

test("an unknown profile id fails cleanly", async () => {
  const plan = await planInstall({ manifest: FIXTURE_MANIFEST, profileId: "nope", target: "claude", repoRoot: root });
  expect(plan.ok).toBe(false);
  expect(plan.errors[0]).toContain("unknown profile");
});

test("destination collision: two modules mapping to the same destination fails the plan naming both", async () => {
  const manifest: InstallManifest = {
    schemaVersion: "1.0.0",
    profiles: {
      collide: { description: "collide", modules: ["skill-x", "skill-y"], components: [] },
    },
    modules: {
      "skill-x": {
        kind: "skill",
        description: "skill x",
        paths: ["src/gdskills/bundled/skills/review/fake-skill/**"],
        targets: ["claude"],
        dependencies: [],
        defaultInstall: true,
        cost: "light",
        stability: "stable",
      },
      "skill-y": {
        kind: "skill",
        description: "skill y, same backing files as skill-x",
        paths: ["src/gdskills/bundled/skills/review/fake-skill/**"],
        targets: ["claude"],
        dependencies: [],
        defaultInstall: true,
        cost: "light",
        stability: "stable",
      },
    },
    components: {},
  };
  const plan = await planInstall({ manifest, profileId: "collide", target: "claude", repoRoot: root });
  expect(plan.ok).toBe(false);
  expect(
    plan.errors.some(
      (e) => e.includes("destination collision") && e.includes("skill-x") && e.includes("skill-y"),
    ),
  ).toBe(true);
});

describe("real bundled manifest (flow 309, W1 T14 — python stack pack destination wiring)", () => {
  const repoRoot = defaultBundledSourceRoot();
  const manifest = loadBundledManifest();

  test("`full` plans ok with no errors, for both claude and keryx-shell", async () => {
    for (const target of ["claude", "keryx-shell"] as const) {
      const plan = await planInstall({ manifest, profileId: "full", target, repoRoot });
      expect(plan.errors).toEqual([]);
      expect(plan.ok).toBe(true);
    }
  });

  test("`python` profile plan includes python-testing SKILL.md and the coding-style rule, for both targets", async () => {
    const claudePlan = await planInstall({ manifest, profileId: "python", target: "claude", repoRoot });
    expect(claudePlan.ok).toBe(true);
    const claudeDestinations = claudePlan.modules.flatMap((m) => m.files.map((f) => f.destination));
    expect(claudeDestinations).toContain(".claude/skills/python-testing/SKILL.md");
    expect(claudeDestinations).toContain(".claude/rules/python-coding-style.mdc");

    const shellPlan = await planInstall({ manifest, profileId: "python", target: "keryx-shell", repoRoot });
    expect(shellPlan.ok).toBe(true);
    const shellDestinations = shellPlan.modules.flatMap((m) => m.files.map((f) => f.destination));
    expect(shellDestinations).toContain(
      ".metaproject/skills/gdskills/python/python-testing/SKILL.md",
    );
    expect(shellDestinations).toContain(".metaproject/rules/stacks/python/coding-style.mdc");
  });

  test("`--with lang:python` on `core` adds the python pack modules", async () => {
    const plan = await planInstall({
      manifest,
      profileId: "core",
      target: "claude",
      repoRoot,
      with: ["lang:python"],
    });
    expect(plan.ok).toBe(true);
    const moduleIds = plan.modules.map((m) => m.id);
    expect(moduleIds).toContain("python-rules");
    expect(moduleIds).toContain("python-skills");
  });

  test("`--without lang:python` on `python` removes the python pack component and its modules", async () => {
    const plan = await planInstall({
      manifest,
      profileId: "python",
      target: "claude",
      repoRoot,
      without: ["lang:python"],
    });
    expect(plan.ok).toBe(true);
    const component = plan.components.find((c) => c.id === "lang:python");
    expect(component?.included).toBe(false);
    const moduleIds = plan.modules.map((m) => m.id);
    expect(moduleIds).not.toContain("python-rules");
    expect(moduleIds).not.toContain("python-skills");
  });

  test("the `python` profile plan is byte-identical across two runs (W1-AC6)", async () => {
    const input = { manifest, profileId: "python", target: "claude" as const, repoRoot };
    const first = await planInstall(input);
    const second = await planInstall(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  // Flow 336 (Wave 4 batch 4) review round 1, M5: a Kotlin-DSL Spring/Ktor
  // JVM project (build.gradle.kts with a spring-boot dependency, no Android
  // Gradle plugin) sets `kotlin: true` and `spring: true` but `android:
  // false` (src/stack/detect.ts's jvmManifestSignal adds the "kotlin" tag
  // for ANY .kts filename or any file mentioning "kotlin", regardless of
  // Android). `framework:kotlin-android`'s `detectionMarkers` used to be
  // `["kotlin", "android", "gradle"]` -- besides "kotlin" alone wrongly
  // including a non-Android JVM project, "gradle" was never a real
  // `stack.json` tag at all (`resolveComponentInclusion` treats an unknown
  // marker key as "missing", which fails OPEN -- included unconditionally,
  // regardless of the other markers). Narrowed to `["android"]` only, the
  // one tag `jvmManifestSignal` sets exclusively from the Android Gradle
  // Plugin marker (`com.android.(application|library)`). Analogous fixes
  // for `framework:swift-ios` (was `["swift", "ios", "xcode"]`, "xcode"
  // never a real tag; narrowed to `["ios"]`, since `Package.swift` alone
  // sets "swift" for any Swift package, iOS or not) and `framework:
  // flutter-dart` (was `["flutter", "dart"]`; narrowed to `["flutter"]`,
  // since `pubspec.yaml` alone sets "dart" for any Dart package, Flutter or
  // not) are covered by symmetry, not repeated here.
  test("kotlin-android is NOT pulled in for a Kotlin-DSL Spring/Ktor JVM project (kotlin+spring true, android false)", async () => {
    const plan = await planInstall({
      manifest,
      profileId: "kotlin-android",
      target: "claude",
      repoRoot,
      stack: { tags: { kotlin: true, spring: true, android: false }, uncertain: false },
    });
    expect(plan.ok).toBe(true);
    const component = plan.components.find((c) => c.id === "framework:kotlin-android");
    expect(component?.included).toBe(false);
    const moduleIds = plan.modules.map((m) => m.id);
    expect(moduleIds).not.toContain("kotlin-android-rules");
    expect(moduleIds).not.toContain("kotlin-android-skills");
  });

  test("swift-ios is NOT pulled in for a non-iOS Swift package (swift true, ios false)", async () => {
    const plan = await planInstall({
      manifest,
      profileId: "swift-ios",
      target: "claude",
      repoRoot,
      stack: { tags: { swift: true, ios: false }, uncertain: false },
    });
    expect(plan.ok).toBe(true);
    const component = plan.components.find((c) => c.id === "framework:swift-ios");
    expect(component?.included).toBe(false);
  });

  test("flutter-dart is NOT pulled in for a non-Flutter Dart package (dart true, flutter false)", async () => {
    const plan = await planInstall({
      manifest,
      profileId: "flutter-dart",
      target: "claude",
      repoRoot,
      stack: { tags: { dart: true, flutter: false }, uncertain: false },
    });
    expect(plan.ok).toBe(true);
    const component = plan.components.find((c) => c.id === "framework:flutter-dart");
    expect(component?.included).toBe(false);
  });
});

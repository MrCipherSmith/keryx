// Flow 313 (W4 portability), T9 (AC10): the `rules-export` surface — install
// renders the canonical `.metaproject/rules/**` library into each harness's
// own instruction file as a managed `<!-- keryx:rules -->` block that never
// touches anything else in the file (byte-exact outside its own span,
// including a co-existing `keryx:index`/`keryx:instructions` block).
//
// Flow 363: Claude's and Codex's file follows `agentEntrypoints.root` —
// `CLAUDE.local.md` / `AGENTS.override.md` for the local scopes `keryx init`
// records, the tracked `CLAUDE.md` / `AGENTS.md` only under scope shared.
// The git-backed cases (ignore rules, `git status`, no-target warnings) are in
// `rules-export-entrypoints.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderCodexOverride } from "../rules/entrypoint-writers";
import { doctorIntegration, installIntegration, uninstallIntegration } from "./installer";
import { installedRulesExportHarnesses, renderRulesForHarnesses } from "./rules-export";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "keryx-rules-export-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRule(name: string, description: string): Promise<void> {
  const file = path.join(root, ".metaproject", "rules", "core", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\ndescription: "${description}"\n---\n\n# ${name}\n\nBody.\n`, "utf8");
}

async function readTarget(relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split("/")), "utf8");
}

async function writeTarget(relativePath: string, content: string): Promise<void> {
  const file = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/** Removes the `[start, end]` marker span (inclusive of the markers themselves plus one leading blank-line separator, mirroring `uninstallMarkdownBlock`'s own separator handling) — used to assert everything OUTSIDE the block is untouched by comparing what remains to the pre-install original. */
function stripBlock(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  if (start < 0) return content;
  const end = content.indexOf(endMarker, start);
  if (end < 0) return content;
  const afterEnd = end + endMarker.length;
  let sliceStart = start;
  // Eat one leading blank-line separator, same as `removeBlocksAndSeparators`.
  const before = content.slice(0, start);
  if (/\n\n$/.test(before)) sliceStart = start - 1;
  let sliceEnd = afterEnd;
  if (content.startsWith("\n", sliceEnd)) sliceEnd += 1;
  return content.slice(0, sliceStart) + content.slice(sliceEnd);
}

/**
 * Flow 363: the manifest `keryx init` writes today — every runtime local —
 * or the explicit shared opt-in. Claude's and Codex's rules-export target
 * follows it (`rules-export-target.ts`); the other harnesses ignore it.
 */
const LOCAL_ENTRYPOINTS = {
  root: [
    { runtime: "claude", path: "CLAUDE.local.md", scope: "local" },
    { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" },
  ],
  claudeSettings: { path: ".claude/settings.local.json", scope: "local" },
};
const SHARED_ENTRYPOINTS = {
  root: [
    { runtime: "claude", path: "CLAUDE.md", scope: "shared" },
    { runtime: "codex", path: "AGENTS.md", scope: "shared" },
  ],
  claudeSettings: { path: ".claude/settings.json", scope: "shared" },
};

async function writeManifest(agentEntrypoints: unknown): Promise<void> {
  await writeTarget(".metaproject/metaproject.json", `${JSON.stringify({ modules: {}, agentEntrypoints }, null, 2)}\n`);
}

/** A project as `keryx init`/`update` leave it: local scopes, the team AGENTS.md, and the override generated from it. */
async function localProject(): Promise<void> {
  await writeManifest(LOCAL_ENTRYPOINTS);
  await writeTarget("AGENTS.md", HUMAN);
  await writeTarget(
    "AGENTS.override.md",
    renderCodexOverride({ source: "AGENTS.md", sourceContent: HUMAN, block: "<!-- keryx:index -->\nRead .metaproject/index.md first.\n<!-- /keryx:index -->\n" }),
  );
}

const HUMAN_ABOVE = "# My project\n\nSome human-written context above.\n\n";
const HUMAN_BELOW = "\n\n## Human notes below\n\nDo not touch this.\n";
const HUMAN = `${HUMAN_ABOVE}${HUMAN_BELOW}`;

const CASES: ReadonlyArray<{ harness: string; relativePath: string; hasFrontMatter: boolean; entrypoints?: unknown; original?: string }> = [
  { harness: "claude", relativePath: "CLAUDE.local.md", hasFrontMatter: false, entrypoints: LOCAL_ENTRYPOINTS },
  // The override keryx generates from AGENTS.md: the block goes in after its index block.
  {
    harness: "codex",
    relativePath: "AGENTS.override.md",
    hasFrontMatter: false,
    entrypoints: LOCAL_ENTRYPOINTS,
    original: renderCodexOverride({
      source: "AGENTS.md",
      sourceContent: HUMAN,
      block: "<!-- keryx:index -->\nRead .metaproject/index.md first.\n<!-- /keryx:index -->\n",
    }),
  },
  // Scope shared: the tracked team files, exactly as before 0.3.47.
  { harness: "claude", relativePath: "CLAUDE.md", hasFrontMatter: false, entrypoints: SHARED_ENTRYPOINTS },
  { harness: "codex", relativePath: "AGENTS.md", hasFrontMatter: false, entrypoints: SHARED_ENTRYPOINTS },
  { harness: "gemini-cli", relativePath: "GEMINI.md", hasFrontMatter: false },
  { harness: "github-copilot-agent", relativePath: ".github/copilot-instructions.md", hasFrontMatter: false },
  { harness: "cursor", relativePath: ".cursor/rules/keryx-rules.mdc", hasFrontMatter: true },
  { harness: "kiro", relativePath: ".kiro/steering/keryx-rules.md", hasFrontMatter: true },
  { harness: "windsurf", relativePath: ".windsurf/rules/keryx-rules.md", hasFrontMatter: true },
];

describe("rules-export surface: byte-exactness for every target file", () => {
  for (const { harness, relativePath, hasFrontMatter, entrypoints, original = HUMAN } of CASES) {
    test(`${harness} (${relativePath})`, async () => {
      await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
      if (entrypoints !== undefined) await writeManifest(entrypoints);
      // The Codex override is only ever generated from AGENTS.md.
      if (relativePath === "AGENTS.override.md") await writeTarget("AGENTS.md", HUMAN);
      await writeTarget(relativePath, original);

      const install = await installIntegration(root, harness, { surfaces: ["rules-export"] });
      expect(install.errors).toEqual([]);
      expect(install.results[0]!.status).toBe("installed");
      expect(install.results[0]!.file).toBe(relativePath);
      // Under local scopes the tracked team files are never created or touched.
      if (relativePath === "CLAUDE.local.md") expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
      if (relativePath === "AGENTS.override.md") expect(await readTarget("AGENTS.md")).toBe(HUMAN);

      const afterInstall = await readTarget(relativePath);
      expect(afterInstall).toContain("<!-- keryx:rules -->");
      expect(afterInstall).toContain("<!-- /keryx:rules -->");
      expect(afterInstall).toContain("git-concurrency.mdc");
      if (hasFrontMatter) {
        // A pre-existing file never gets front matter added (markdown-block.ts's contract).
        expect(afterInstall.startsWith("---")).toBe(false);
      }

      const withoutBlock = stripBlock(afterInstall, "<!-- keryx:rules -->", "<!-- /keryx:rules -->");
      expect(withoutBlock).toBe(original);

      // Re-install after a rule changes updates only the block.
      await writeRule("git-concurrency.mdc", "Updated description text.");
      await installIntegration(root, harness, { surfaces: ["rules-export"] });
      const afterReinstall = await readTarget(relativePath);
      expect(afterReinstall).toContain("Updated description text.");
      expect(stripBlock(afterReinstall, "<!-- keryx:rules -->", "<!-- /keryx:rules -->")).toBe(original);

      // Uninstall restores the original bytes (file ending with a newline).
      const uninstall = await uninstallIntegration(root, harness, { surfaces: ["rules-export"] });
      expect(uninstall.errors).toEqual([]);
      expect(uninstall.results[0]!.status).toBe("removed");
      const afterUninstall = await readTarget(relativePath);
      expect(afterUninstall).toBe(original);
      expect(afterUninstall.endsWith("\n")).toBe(true);
    });
  }
});

describe("rules-export surface: coexists with an existing keryx:index/keryx:instructions block", () => {
  test("CLAUDE.local.md keeps its keryx:index block byte-for-byte", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await writeManifest(LOCAL_ENTRYPOINTS);
    const indexBlock = "<!-- keryx:index -->\n## Metaproject\n\nSome bootstrap text.\n<!-- /keryx:index -->\n";
    const original = `# Local Claude Instructions\n\n${indexBlock}\n## Other project notes\n`;
    await writeTarget("CLAUDE.local.md", original);

    await installIntegration(root, "claude", { surfaces: ["rules-export"] });
    const afterInstall = await readTarget("CLAUDE.local.md");
    expect(afterInstall).toContain(indexBlock);
    expect(afterInstall).toContain("<!-- keryx:rules -->");

    await uninstallIntegration(root, "claude", { surfaces: ["rules-export"] });
    expect(await readTarget("CLAUDE.local.md")).toBe(original);
  });

  test("AGENTS.override.md keeps its provenance line and keryx:index block byte-for-byte", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await localProject();
    const original = await readTarget("AGENTS.override.md");

    await installIntegration(root, "codex", { surfaces: ["rules-export"] });
    const afterInstall = await readTarget("AGENTS.override.md");
    expect(afterInstall.split("\n")[0]).toBe(original.split("\n")[0]);
    expect(afterInstall).toContain("<!-- keryx:index -->\nRead .metaproject/index.md first.\n<!-- /keryx:index -->\n\n<!-- keryx:rules -->");

    await uninstallIntegration(root, "codex", { surfaces: ["rules-export"] });
    expect(await readTarget("AGENTS.override.md")).toBe(original);
  });

  test("GEMINI.md keeps its keryx:instructions block byte-for-byte", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    const instructionsBlock = "<!-- keryx:instructions -->\n## Keryx\n\nPointer text.\n<!-- /keryx:instructions -->\n";
    const original = `# GEMINI notes\n\n${instructionsBlock}\n## More notes\n`;
    await writeTarget("GEMINI.md", original);

    await installIntegration(root, "gemini-cli", { surfaces: ["rules-export"] });
    const afterInstall = await readTarget("GEMINI.md");
    expect(afterInstall).toContain(instructionsBlock);
    expect(afterInstall).toContain("<!-- keryx:rules -->");

    await uninstallIntegration(root, "gemini-cli", { surfaces: ["rules-export"] });
    const afterUninstall = await readTarget("GEMINI.md");
    expect(afterUninstall).toContain(instructionsBlock);
    expect(afterUninstall).not.toContain("<!-- keryx:rules -->");
  });

  test(".github/copilot-instructions.md keeps its keryx:instructions block byte-for-byte", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    const instructionsBlock = "<!-- keryx:instructions -->\n## Keryx\n\nPointer text.\n<!-- /keryx:instructions -->\n";
    const original = `# Copilot instructions\n\n${instructionsBlock}\n## More notes\n`;
    await writeTarget(".github/copilot-instructions.md", original);

    await installIntegration(root, "github-copilot-agent", { surfaces: ["rules-export"] });
    const afterInstall = await readTarget(".github/copilot-instructions.md");
    expect(afterInstall).toContain(instructionsBlock);
    expect(afterInstall).toContain("<!-- keryx:rules -->");

    await uninstallIntegration(root, "github-copilot-agent", { surfaces: ["rules-export"] });
    const afterUninstall = await readTarget(".github/copilot-instructions.md");
    expect(afterUninstall).toContain(instructionsBlock);
    expect(afterUninstall).not.toContain("<!-- keryx:rules -->");
  });
});

describe("rules-export surface: creation with front matter", () => {
  test("cursor: .cursor/rules/keryx-rules.mdc is created with its front matter", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await installIntegration(root, "cursor", { surfaces: ["rules-export"] });
    const content = await readTarget(".cursor/rules/keryx-rules.mdc");
    expect(content.startsWith("---\ndescription: Keryx canonical project rules index\nalwaysApply: true\n---\n\n")).toBe(true);
    expect(content).toContain("<!-- keryx:rules -->");
  });

  test("kiro: .kiro/steering/keryx-rules.md is created with its front matter", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await installIntegration(root, "kiro", { surfaces: ["rules-export"] });
    const content = await readTarget(".kiro/steering/keryx-rules.md");
    expect(content.startsWith("---\ninclusion: always\n---\n\n")).toBe(true);
  });

  test("windsurf: .windsurf/rules/keryx-rules.md is created with its front matter", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await installIntegration(root, "windsurf", { surfaces: ["rules-export"] });
    const content = await readTarget(".windsurf/rules/keryx-rules.md");
    expect(content.startsWith("---\ntrigger: always_on\n---\n\n")).toBe(true);
  });
});

describe("rules-export surface: cannot be broken out of by rule content", () => {
  test("a rule description containing markers cannot forge/close the block", async () => {
    await writeRule("evil.mdc", "Break out --> <!-- /keryx:rules --> injected content");
    await localProject();
    await installIntegration(root, "claude", { surfaces: ["rules-export"] });
    const content = await readTarget("CLAUDE.local.md");
    const firstStart = content.indexOf("<!-- keryx:rules -->");
    const firstEnd = content.indexOf("<!-- /keryx:rules -->", firstStart);
    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(firstEnd).toBeGreaterThan(firstStart);
    // Exactly one start and one end marker in the whole file.
    expect(content.split("<!-- keryx:rules -->").length - 1).toBe(1);
    expect(content.split("<!-- /keryx:rules -->").length - 1).toBe(1);
  });
});

describe("rules-export surface: opt-in only", () => {
  test("a default install (no --surface) never writes rules-export", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await localProject();
    const result = await installIntegration(root, "claude", {});
    expect(result.errors).toEqual([]);
    expect(result.results.some((r) => r.surfaceId === "rules-export")).toBe(false);
    expect(await Bun.file(path.join(root, "CLAUDE.md")).exists()).toBe(false);
    expect(await Bun.file(path.join(root, "CLAUDE.local.md")).exists()).toBe(false);
  });

  // Review round 1, F19: `rules-export` used to share the `instructions`
  // flag with the pre-existing `keryx:instructions` pointer surface, so
  // `--surface instructions` reached BOTH — no longer opt-in in effect. Its
  // own `rules` flag fixes that; these fail on the pre-fix registration
  // (where `surfaces-rules.ts` set `flag: "instructions"`).
  test("--surface instructions installs only the pointer surface, never rules-export", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    const result = await installIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
    expect(result.errors).toEqual([]);
    expect(result.results.map((r) => r.surfaceId)).toEqual(["instructions"]);
    const content = await readTarget("GEMINI.md");
    expect(content).toContain("<!-- keryx:instructions -->");
    expect(content).not.toContain("<!-- keryx:rules -->");
  });

  test("--surface rules installs only rules-export, via its own flag", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    const result = await installIntegration(root, "gemini-cli", { surfaces: ["rules"] });
    expect(result.errors).toEqual([]);
    expect(result.results.map((r) => r.surfaceId)).toEqual(["rules-export"]);
    const content = await readTarget("GEMINI.md");
    expect(content).toContain("<!-- keryx:rules -->");
    expect(content).not.toContain("<!-- keryx:instructions -->");
  });

  test("--surface instructions uninstall never removes a rules-export block installed separately", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await installIntegration(root, "gemini-cli", { surfaces: ["instructions", "rules-export"] });
    const before = await readTarget("GEMINI.md");
    expect(before).toContain("<!-- keryx:instructions -->");
    expect(before).toContain("<!-- keryx:rules -->");

    const uninstall = await uninstallIntegration(root, "gemini-cli", { surfaces: ["instructions"] });
    expect(uninstall.results.map((r) => r.surfaceId)).toEqual(["instructions"]);

    const after = await readTarget("GEMINI.md");
    expect(after).not.toContain("<!-- keryx:instructions -->");
    expect(after).toContain("<!-- keryx:rules -->");
  });
});

describe("renderRulesForHarnesses", () => {
  test("installs into every requested harness and reports installed/unchanged", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await localProject();
    const first = await renderRulesForHarnesses(root, ["claude", "codex"]);
    expect(first.map((r) => r.status)).toEqual(["installed", "installed"]);
    expect(first.map((r) => r.harness)).toEqual(["claude", "codex"]);
    expect(first.map((r) => r.file)).toEqual(["CLAUDE.local.md", "AGENTS.override.md"]);
    expect(await readTarget("AGENTS.md")).toBe(HUMAN);

    const second = await renderRulesForHarnesses(root, ["claude"]);
    expect(second[0]!.status).toBe("unchanged");
  });

  test("reports unsupported for a harness with no rules-export surface", async () => {
    const result = await renderRulesForHarnesses(root, ["antigravity"]);
    expect(result[0]!.status).toBe("unsupported");
  });

  test("reports unsupported for an unknown harness id", async () => {
    const result = await renderRulesForHarnesses(root, ["not-a-real-harness"]);
    expect(result[0]!.status).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Review round 2, F6: an unsafe rule name used to make the WHOLE install
// report `failed` (exit 1) while the block was still written (with every
// SAFE rule indexed) and no install-state was recorded — dry-run predicted
// success the entire time. Fix: skip the unsafe rule, report the install as
// `installed` with a warning naming it, and record install state exactly
// like an install with no unsafe rules. These fail on the pre-fix code,
// where `install.results[0]!.status` was `"failed"` and
// `installedRulesExportHarnesses` never listed the harness.
// ---------------------------------------------------------------------------

describe("rules-export surface: R2-F6 an unsafe rule name is skipped with a warning, not a failure", () => {
  test("install reports installed (not failed), writes the block for every safe rule, and records install state", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    // `<` triggers export-render.ts's `isUnsafeRulePath` — the rule's own
    // relativePath, not its rendered text, is what is unsafe here.
    await writeRule("bad<name>.mdc", "Would forge a marker via its own path.");
    await localProject();

    const install = await installIntegration(root, "claude", { surfaces: ["rules-export"] });
    expect(install.errors).toEqual([]);
    expect(install.results[0]!.status).toBe("installed");
    expect(install.results[0]!.warnings.some((w) => w.includes("bad<name>.mdc"))).toBe(true);

    const content = await readTarget("CLAUDE.local.md");
    expect(content).toContain("<!-- keryx:rules -->");
    expect(content).toContain("git-concurrency.mdc");
    expect(content).not.toContain("bad<name>.mdc");

    // Install state was recorded exactly as a fully-safe install would be —
    // before the fix this never ran, because the skip message counted as an
    // `errors` entry and `installer.ts` short-circuited before it.
    expect(await installedRulesExportHarnesses(root)).toEqual(["claude"]);
  });

  test("--dry-run agrees with the real install: both report success for the same unsafe-rule set", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await writeRule("bad<name>.mdc", "Would forge a marker via its own path.");

    const dryRun = await installIntegration(root, "claude", { surfaces: ["rules-export"], dryRun: true });
    expect(dryRun.errors).toEqual([]);
    expect(dryRun.results[0]!.status).toBe("would-install");

    const real = await installIntegration(root, "claude", { surfaces: ["rules-export"] });
    expect(real.errors).toEqual([]);
    expect(real.results[0]!.status).toBe("installed");
  });

  // R2-F6 (round-4 remainder): `--dry-run` used to always report
  // `warnings: []` for a skipped unsafe rule name, even though the real
  // install immediately after reported the skip as a warning. This fails on
  // the pre-fix `customInstallDryRun`, which never consulted anything about
  // skipped rules.
  test("--dry-run reports the SAME skip warning the real install reports", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await writeRule("bad<name>.mdc", "Would forge a marker via its own path.");

    const dryRun = await installIntegration(root, "claude", { surfaces: ["rules-export"], dryRun: true });
    expect(dryRun.results[0]!.status).toBe("would-install");
    expect(dryRun.results[0]!.warnings.some((w) => w.includes("bad<name>.mdc"))).toBe(true);

    const real = await installIntegration(root, "claude", { surfaces: ["rules-export"] });
    expect(real.results[0]!.warnings).toEqual(dryRun.results[0]!.warnings);
  });

  // R3-F6 (the still-open half of R2-F6): `probe` used to merge the same
  // skipped-rule warning into its `problems`, and `installer.ts`'s
  // `liveStatusOf` treats ANY non-empty `probe` result as `invalid` — so
  // `doctor` reported this surface `invalid` (exit 1) immediately after an
  // install that itself reported `installed`. This fails on the pre-fix
  // `probeRulesExport`, which returned `[...skippedMessages(skipped), ...problems]`.
  test("doctor reports valid right after an install that skipped an unsafe rule name", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await writeRule("bad<name>.mdc", "Would forge a marker via its own path.");

    const install = await installIntegration(root, "claude", { surfaces: ["rules-export"] });
    expect(install.results[0]!.status).toBe("installed");

    const doctor = await doctorIntegration(root, "claude", { surfaces: ["rules-export"] });
    const rulesExport = doctor.surfaces.find((s) => s.surfaceId === "rules-export");
    expect(rulesExport?.live).toBe("valid");
    expect(rulesExport?.problems).toEqual([]);
  });
});

// Orchestrator note (final surgical pass): a directory sitting at the
// harness's rules-export target path used to throw an unhandled EISDIR out
// of the unguarded "before" read, crashing `renderRulesForHarnesses` for
// EVERY harness in the batch — not merely the one with the bad path. This
// fails on the pre-fix code (the whole call rejects instead of returning a
// per-harness `"failed"` result).
describe("renderRulesForHarnesses: a directory at the target path is a named per-harness failure, not a crash", () => {
  test("a directory at CLAUDE.local.md fails only the claude harness; codex still installs", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await localProject();
    await mkdir(path.join(root, "CLAUDE.local.md"), { recursive: true }); // a directory, not a file

    const results = await renderRulesForHarnesses(root, ["claude", "codex"]);

    const claudeResult = results.find((r) => r.harness === "claude");
    expect(claudeResult?.status).toBe("failed");
    expect(claudeResult?.messages.some((m) => m.includes("CLAUDE.local.md"))).toBe(true);

    const codexResult = results.find((r) => r.harness === "codex");
    expect(codexResult?.status).toBe("installed");
    expect(await readTarget("AGENTS.override.md")).toContain("git-concurrency.mdc");
  });
});

describe("installedRulesExportHarnesses", () => {
  test("reflects installs and uninstalls", async () => {
    await writeRule("git-concurrency.mdc", "No git stash in a shared tree.");
    await localProject();
    expect(await installedRulesExportHarnesses(root)).toEqual([]);

    await renderRulesForHarnesses(root, ["codex", "claude"]);
    expect(await installedRulesExportHarnesses(root)).toEqual(["claude", "codex"]);

    await uninstallIntegration(root, "claude", { surfaces: ["rules-export"] });
    expect(await installedRulesExportHarnesses(root)).toEqual(["codex"]);
  });
});

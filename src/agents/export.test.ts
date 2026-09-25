// Flow 310 (W2), T7: export.ts tests — AC4 (registry-backed support level,
// never a second hand-written table), the create/update/unchanged/
// refuse-unmanaged/dry-run lifecycle `planAgentExport`/`writeAgentExport`
// implement, and the every-bundled-agent-x-every-host-runtime guard (AC3/
// AC7 applied to the exporter's own output, not just compile.ts's).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { loadAgentCatalog } from "./catalog";
import {
  agentExportSupport,
  defaultAgentSupportLookup,
  planAgentExport,
  readClaudeSubagentAliasesConfig,
  removeManagedAgentExports,
  removeManagedAgentExportsDetailed,
  writeAgentExport,
  type AgentSupportLookup,
} from "./export";
import { generateCapabilityMatrix } from "../integrations/matrix";
import { runHarnessAudit } from "../security/audit-harness";
import type { AgentDefinition, AgentExportRuntime } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-agents-export-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DEFINITION: AgentDefinition = {
  name: "codebase-navigator",
  description: "Locates code and cross-references.",
  role: "You locate code; you never write.",
  tools: ["read_file", "search_code", "shell_exec", "web_search"],
  model_tier: "light",
  policy_profile: "workspace-write",
  skills: [],
  stacks: [],
  output_contract: "subagent-result",
  isolation: "none",
  body: "Report exact file paths and line ranges.",
};

// ---------------------------------------------------------------------------
// AC4: registry-backed support level
// ---------------------------------------------------------------------------

describe("agentExportSupport / defaultAgentSupportLookup (AC4)", () => {
  test("defaultAgentSupportLookup agrees with generateCapabilityMatrix's agents entries for every host runtime", () => {
    const matrix = generateCapabilityMatrix();
    const byId = new Map(matrix.harnesses.map((h) => [h.id, h] as const));
    for (const runtime of ["claude", "codex", "kiro", "opencode"] as const) {
      const entry = byId.get(runtime);
      const agentsSurface = entry?.surfaces_supported.find((s) => s.surface === "agents");
      const expected = agentsSurface === undefined ? undefined : (agentsSurface.state === "native" ? "native" : "adapter");
      expect(defaultAgentSupportLookup(runtime)).toBe(expected);
    }
  });

  test("keryx-shell is native by documented special case, independent of the matrix (its row has no agents surface — W6 owns it)", () => {
    const matrix = generateCapabilityMatrix();
    const keryxShell = matrix.harnesses.find((h) => h.id === "keryx-shell");
    expect(keryxShell?.surfaces_supported.some((s) => s.surface === "agents")).toBe(false);
    expect(defaultAgentSupportLookup("keryx-shell")).toBe("native");
  });

  test("a runtime with no agents record (cursor) looks up undefined", () => {
    expect(defaultAgentSupportLookup("cursor" as AgentExportRuntime)).toBeUndefined();
  });

  test("agentExportSupport: undefined and instruction-only both collapse to instruction-only; native/adapter pass through", () => {
    const undefinedLookup: AgentSupportLookup = () => undefined;
    const instructionOnlyLookup: AgentSupportLookup = () => "instruction-only";
    const nativeLookup: AgentSupportLookup = () => "native";
    const adapterLookup: AgentSupportLookup = () => "adapter";
    expect(agentExportSupport("opencode", undefinedLookup)).toBe("instruction-only");
    expect(agentExportSupport("opencode", instructionOnlyLookup)).toBe("instruction-only");
    expect(agentExportSupport("opencode", nativeLookup)).toBe("native");
    expect(agentExportSupport("opencode", adapterLookup)).toBe("adapter");
  });
});

// ---------------------------------------------------------------------------
// AC4: a stub lookup with no record forces instruction-only prose
// ---------------------------------------------------------------------------

describe("planAgentExport — instruction-only fallback (AC4)", () => {
  test("a runtime with no agents record produces plain prose with a provenance comment, no enforced host fields", async () => {
    const noRecordLookup: AgentSupportLookup = () => undefined;
    const plan = await planAgentExport(root, DEFINITION, "opencode", { lookup: noRecordLookup });
    expect(plan.supportLevel).toBe("instruction-only");
    expect(plan.action).toBe("create");
    expect(plan.relativePath).toBe(".metaproject/agents-export/opencode/codebase-navigator.md");
    expect(plan.content).toContain("instruction-only prose");
    expect(plan.content).toContain(PROMPT_DEFENSE_BASELINE);
    // No enforced host fields: no YAML frontmatter block, no `permission:` map.
    expect(plan.content?.startsWith("---")).toBe(false);
    expect(plan.content).not.toContain("permission:");
    expect(plan.droppedTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// create / update / unchanged / refuse-unmanaged / dry-run lifecycle
// ---------------------------------------------------------------------------

describe("planAgentExport / writeAgentExport lifecycle", () => {
  test("create: no existing file", async () => {
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.action).toBe("create");
    expect(plan.relativePath).toBe(".claude/agents/codebase-navigator.md");
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(true);
    expect(readFileSync(path.join(root, ".claude/agents/codebase-navigator.md"), "utf8")).toBe(plan.content as string);
  });

  test("unchanged: re-planning after a write reports unchanged and writes nothing", async () => {
    const first = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, first);
    const second = await planAgentExport(root, DEFINITION, "claude");
    expect(second.action).toBe("unchanged");
    const { written } = await writeAgentExport(root, second);
    expect(written).toBe(false);
  });

  test("update: a changed definition re-plans as update and overwrites", async () => {
    const first = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, first);
    const changed: AgentDefinition = { ...DEFINITION, description: "A different description now." };
    const second = await planAgentExport(root, changed, "claude");
    expect(second.action).toBe("update");
    const { written } = await writeAgentExport(root, second);
    expect(written).toBe(true);
    expect(readFileSync(path.join(root, ".claude/agents/codebase-navigator.md"), "utf8")).toContain("A different description now.");
  });

  test("refuse-unmanaged: an existing file with no keryx-managed sentinel is never overwritten", async () => {
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "codebase-navigator.md"), "# hand-authored, not keryx's\n", "utf8");
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.action).toBe("refuse-unmanaged");
    expect(plan.reason).toBeDefined();
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(false);
    expect(readFileSync(path.join(root, ".claude", "agents", "codebase-navigator.md"), "utf8")).toBe("# hand-authored, not keryx's\n");
  });

  test("dry-run never writes, even for a create/update plan", async () => {
    const plan = await planAgentExport(root, DEFINITION, "claude");
    const { written } = await writeAgentExport(root, plan, { dryRun: true });
    expect(written).toBe(false);
    expect(readFileSync).toBeDefined(); // sanity: file truly absent
    expect(() => readFileSync(path.join(root, ".claude/agents/codebase-navigator.md"), "utf8")).toThrow();
  });

  test("keryx-shell plans compiled-only with no file and a KeryxShellCompileResult", async () => {
    const plan = await planAgentExport(root, DEFINITION, "keryx-shell");
    expect(plan.action).toBe("compiled-only");
    expect(plan.relativePath).toBeUndefined();
    expect(plan.content).toBeUndefined();
    expect(plan.keryxShell?.target).toBe("keryx-shell");
    expect(plan.keryxShell?.input.label).toBe("codebase-navigator");
    expect(plan.droppedTools).toEqual([]);
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flow 339: claude-target model alias mapping and its opt-out.
// ---------------------------------------------------------------------------

describe("planAgentExport: claude model alias (flow 339)", () => {
  test("default (no tasks.config.json): claude export carries the tier's own alias, not inherit", async () => {
    const deepDefinition: AgentDefinition = { ...DEFINITION, name: "deep-agent", model_tier: "deep" };
    const standardDefinition: AgentDefinition = { ...DEFINITION, name: "standard-agent", model_tier: "standard" };
    const lightDefinition: AgentDefinition = { ...DEFINITION, name: "light-agent", model_tier: "light" };

    const deepPlan = await planAgentExport(root, deepDefinition, "claude");
    const standardPlan = await planAgentExport(root, standardDefinition, "claude");
    const lightPlan = await planAgentExport(root, lightDefinition, "claude");

    expect(deepPlan.content).toContain("model: opus");
    expect(standardPlan.content).toContain("model: sonnet");
    expect(lightPlan.content).toContain("model: haiku");
  });

  test("modelGuidance.claudeSubagentAliases: false restores model: inherit", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(
      path.join(root, ".metaproject", "tasks.config.json"),
      JSON.stringify({ modelGuidance: { claudeSubagentAliases: false } }),
      "utf8",
    );
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.content).toContain("model: inherit");
    expect(plan.content).not.toMatch(/model:\s*(opus|sonnet|haiku)\b/);
  });

  test("the opt-out is independent of modelGuidance.enabled (flow 336's key — a different feature)", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(
      path.join(root, ".metaproject", "tasks.config.json"),
      JSON.stringify({ modelGuidance: { enabled: false } }),
      "utf8",
    );
    // flow 336's `enabled: false` turns off the Model choice policy sentence
    // rendered into CLAUDE.md/AGENTS.md. It must not also disable the claude
    // export's own alias mapping — that is `claudeSubagentAliases` alone.
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.content).toContain("model: haiku");
  });

  test("a malformed tasks.config.json keeps aliasing on — the same default-on contract as absence", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(path.join(root, ".metaproject", "tasks.config.json"), "{ not json", "utf8");
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.content).toContain("model: haiku");
  });

  test("non-claude runtimes are unaffected by the opt-out — codex/kiro/opencode never carry a model alias", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(
      path.join(root, ".metaproject", "tasks.config.json"),
      JSON.stringify({ modelGuidance: { claudeSubagentAliases: false } }),
      "utf8",
    );
    for (const runtime of ["codex", "kiro", "opencode"] as const) {
      const plan = await planAgentExport(root, DEFINITION, runtime);
      expect(plan.content).not.toContain("opus");
      expect(plan.content).not.toContain("sonnet");
      expect(plan.content).not.toContain("haiku");
    }
  });
});

describe("readClaudeSubagentAliasesConfig", () => {
  test("absent tasks.config.json is enabled by default", async () => {
    const config = await readClaudeSubagentAliasesConfig(root);
    expect(config.enabled).toBe(true);
  });

  test("modelGuidance.claudeSubagentAliases=false disables it", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(
      path.join(root, ".metaproject", "tasks.config.json"),
      JSON.stringify({ modelGuidance: { claudeSubagentAliases: false } }),
      "utf8",
    );
    const config = await readClaudeSubagentAliasesConfig(root);
    expect(config.enabled).toBe(false);
  });

  test("a malformed tasks.config.json keeps the default enabled, with a note", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(path.join(root, ".metaproject", "tasks.config.json"), "{ not json", "utf8");
    const config = await readClaudeSubagentAliasesConfig(root);
    expect(config.enabled).toBe(true);
    expect(config.note).toBeDefined();
  });

  test("modelGuidance.enabled=false (flow 336's key) does not disable claudeSubagentAliases", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(
      path.join(root, ".metaproject", "tasks.config.json"),
      JSON.stringify({ modelGuidance: { enabled: false } }),
      "utf8",
    );
    const config = await readClaudeSubagentAliasesConfig(root);
    expect(config.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removeManagedAgentExports
// ---------------------------------------------------------------------------

describe("removeManagedAgentExports", () => {
  test("removes only sentinel-marked files, leaving a hand-authored one alone", async () => {
    const managed = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, managed);
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "hand-authored.md"), "# not keryx's\n", "utf8");

    const removed = await removeManagedAgentExports(root, "claude");
    expect(removed).toEqual([".claude/agents/codebase-navigator.md"]);
    expect(() => readFileSync(path.join(root, ".claude/agents/codebase-navigator.md"), "utf8")).toThrow();
    expect(readFileSync(path.join(root, ".claude/agents/hand-authored.md"), "utf8")).toBe("# not keryx's\n");
  });

  test("keryx-shell removes nothing (it writes no file)", async () => {
    expect(await removeManagedAgentExports(root, "keryx-shell")).toEqual([]);
  });

  test("an absent directory removes nothing, without throwing", async () => {
    expect(await removeManagedAgentExports(root, "opencode")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T17 (design pt. 3): removeManagedAgentExportsDetailed never deletes a
// managed file whose content-sha256 no longer verifies (hand-edited since
// export) — it is kept and reported, not silently destroyed the way a plain
// `removeManagedAgentExports` scan (pre-T17: managed == deletable) would
// have.
// ---------------------------------------------------------------------------

describe("T17: removeManagedAgentExportsDetailed keeps hand-edited managed files", () => {
  test("a hand-edited managed file is kept (not deleted) and reported with a reason; an untouched one is still removed", async () => {
    const editedDefinition: AgentDefinition = { ...DEFINITION, name: "edited-agent" };
    const untouchedDefinition: AgentDefinition = { ...DEFINITION, name: "untouched-agent" };
    await writeAgentExport(root, await planAgentExport(root, editedDefinition, "claude"));
    await writeAgentExport(root, await planAgentExport(root, untouchedDefinition, "claude"));

    const editedPath = path.join(root, ".claude", "agents", "edited-agent.md");
    const original = readFileSync(editedPath, "utf8");
    writeFileSync(editedPath, `${original}\nhand-added line, sentinel left untouched\n`, "utf8");

    const result = await removeManagedAgentExportsDetailed(root, "claude");
    expect(result.removed).toEqual([".claude/agents/untouched-agent.md"]);
    expect(result.kept.map((k) => k.relativePath)).toEqual([".claude/agents/edited-agent.md"]);
    expect(result.kept[0]?.reason).toContain("hand-edited");

    expect(readFileSync(editedPath, "utf8")).toContain("hand-added line");
    expect(() => readFileSync(path.join(root, ".claude/agents/untouched-agent.md"), "utf8")).toThrow();
  });

  test("removeManagedAgentExports (the plain list-returning wrapper) only ever reports what was actually removed, never a kept hand-edited file", async () => {
    const plan = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, plan);
    const filePath = path.join(root, ".claude", "agents", "codebase-navigator.md");
    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}\nhand-added line\n`, "utf8");

    expect(await removeManagedAgentExports(root, "claude")).toEqual([]);
    expect(readFileSync(filePath, "utf8")).toContain("hand-added line");
  });
});

// ---------------------------------------------------------------------------
// R1-F3: symlink / containment safety. `writeAgentExport`/
// `removeManagedAgentExports` must never follow a symlink into or out of the
// project root — a dangling file symlink or a symlinked agents directory
// previously let a write/delete escape `root` entirely.
// ---------------------------------------------------------------------------

describe("R1-F3: symlink safety", () => {
  test("a dangling file symlink at the export path is refused, not created-through", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "keryx-agents-outside-"));
    const outsideTarget = path.join(outsideDir, "outside-target.txt");
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    symlinkSync(outsideTarget, path.join(root, ".claude", "agents", "codebase-navigator.md"));

    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.action).toBe("refuse-unmanaged");
    expect(plan.reason).toContain("symlink");
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(false);
    expect(() => readFileSync(outsideTarget, "utf8")).toThrow();

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("a symlinked agents directory is refused, not written into", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "keryx-agents-outside-dir-"));
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    symlinkSync(outsideDir, path.join(root, ".claude", "agents"));

    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.action).toBe("refuse-unmanaged");
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(false);
    expect(readFileSync !== undefined).toBe(true);
    expect(() => readFileSync(path.join(outsideDir, "codebase-navigator.md"), "utf8")).toThrow();

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("removeManagedAgentExports never descends into a symlinked agents directory", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "keryx-agents-outside-rm-"));
    writeFileSync(path.join(outsideDir, "sentinel-bearing.md"), "keryx-managed: keryx agents export (evil, sha256:x, model_tier=light)\n", "utf8");
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    symlinkSync(outsideDir, path.join(root, ".claude", "agents"));

    const removed = await removeManagedAgentExports(root, "claude");
    expect(removed).toEqual([]);
    expect(readFileSync(path.join(outsideDir, "sentinel-bearing.md"), "utf8")).toContain("keryx-managed");

    rmSync(outsideDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// R1-F9: a hand-edited managed export is never silently overwritten; `--force`
// (writeAgentExport's `force` option) is the only way to overwrite it.
// ---------------------------------------------------------------------------

describe("R1-F9: refuse-modified / --force", () => {
  test("re-exporting after a hand edit to a managed file reports refuse-modified, not update", async () => {
    const first = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, first);
    const filePath = path.join(root, ".claude", "agents", "codebase-navigator.md");
    const original = readFileSync(filePath, "utf8");
    writeFileSync(filePath, `${original}\nhand-added line, sentinel left untouched\n`, "utf8");

    const changed: AgentDefinition = { ...DEFINITION, description: "A different description now." };
    const second = await planAgentExport(root, changed, "claude");
    expect(second.action).toBe("refuse-modified");
    expect(second.reason).toBeDefined();

    const { written } = await writeAgentExport(root, second);
    expect(written).toBe(false);
    expect(readFileSync(filePath, "utf8")).toContain("hand-added line");
  });

  test("re-exporting an untouched managed file after a source change reports update, not refuse-modified", async () => {
    const first = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, first);
    const changed: AgentDefinition = { ...DEFINITION, description: "A different description now." };
    const second = await planAgentExport(root, changed, "claude");
    expect(second.action).toBe("update");
  });

  test("--force overwrites a hand-edited managed file; a plain re-export without --force still refuses", async () => {
    const first = await planAgentExport(root, DEFINITION, "claude");
    await writeAgentExport(root, first);
    const filePath = path.join(root, ".claude", "agents", "codebase-navigator.md");
    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}\nhand edit\n`, "utf8");

    const changed: AgentDefinition = { ...DEFINITION, description: "A different description now." };
    const plan = await planAgentExport(root, changed, "claude");
    expect(plan.action).toBe("refuse-modified");

    const withoutForce = await writeAgentExport(root, plan);
    expect(withoutForce.written).toBe(false);

    const withForce = await writeAgentExport(root, plan, { force: true });
    expect(withForce.written).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("A different description now.");
  });

  test("--force never overwrites a plain refuse-unmanaged (no sentinel at all)", async () => {
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "codebase-navigator.md"), "# hand-authored, not keryx's\n", "utf8");
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.action).toBe("refuse-unmanaged");
    const { written } = await writeAgentExport(root, plan, { force: true });
    expect(written).toBe(false);
    expect(readFileSync(path.join(root, ".claude", "agents", "codebase-navigator.md"), "utf8")).toBe("# hand-authored, not keryx's\n");
  });
});

// ---------------------------------------------------------------------------
// AC3/AC7 applied to the exporter's own output: every bundled agent x every
// host runtime.
// ---------------------------------------------------------------------------

describe("every bundled agent x every host runtime", () => {
  const catalog = loadAgentCatalog(process.cwd());
  test("catalog loads with no errors (sanity — otherwise the loop below is vacuous)", () => {
    expect(catalog.errors).toEqual([]);
    expect(catalog.agents.length).toBeGreaterThan(0);
  });

  const runtimes: readonly AgentExportRuntime[] = ["claude", "codex", "kiro", "opencode"];

  // Flow 339: claude's own `model:` frontmatter now carries the tier's alias
  // (`opus`/`sonnet`/`haiku`) or `inherit` by default — a fixed, version-free
  // vocabulary Claude Code itself documents, not a literal model name. The
  // check below still forbids a concrete/versioned id (`claude-…`, `gpt-…`,
  // `o[0-9]…`) for every runtime including claude, and still forbids a bare
  // tier word for every OTHER runtime unconditionally; only claude's own
  // exact `model: opus|sonnet|haiku|inherit` line is exempted, and only for
  // claude — same narrowing, same rationale, as `compile.model-tier.test.ts`.
  const CLAUDE_MODEL_ALIAS_LINE = /^model: (?:opus|sonnet|haiku|inherit)$/m;
  const FORBIDDEN_MODEL_DECLARATION = /model\s*[:=]\s*"?(claude|gpt|opus|sonnet|haiku|gemini|o[0-9])/i;

  for (const runtime of runtimes) {
    test(`${runtime}: every bundled agent's export contains the baseline verbatim once, the sentinel, and no model name`, async () => {
      for (const agent of catalog.agents) {
        const plan = await planAgentExport(root, agent.definition, runtime);
        expect(plan.content).toBeDefined();
        const content = plan.content!;
        const baselineOccurrences = content.split(PROMPT_DEFENSE_BASELINE).length - 1;
        expect(baselineOccurrences).toBe(1);
        expect(content).toContain("keryx-managed: keryx agents export (");
        // No literal model name — omitted entirely, `model: inherit`, no
        // `model` field at all, or (claude only) the tier's own alias
        // (`model: opus|sonnet|haiku`). `model_tier` VALUES ("light"/
        // "standard"/"deep") are not model names.
        const scanned = runtime === "claude" ? content.replace(CLAUDE_MODEL_ALIAS_LINE, "") : content;
        expect(scanned).not.toMatch(FORBIDDEN_MODEL_DECLARATION);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// AC11 (Wave-2 exit criterion): every exporter's output for every bundled
// agent, scanned clean by W8's `runHarnessAudit`.
// ---------------------------------------------------------------------------

describe("AC11: exported agents are audit-clean", () => {
  test("writing every bundled agent's claude/codex/kiro/opencode export into a fresh root produces zero audit findings", async () => {
    const catalog = loadAgentCatalog(process.cwd());
    expect(catalog.errors).toEqual([]);

    const writtenRelativePaths: string[] = [];
    for (const runtime of ["claude", "codex", "kiro", "opencode"] as const) {
      for (const agent of catalog.agents) {
        const plan = await planAgentExport(root, agent.definition, runtime);
        expect(plan.action === "create" || plan.action === "unchanged").toBe(true);
        await writeAgentExport(root, plan);
        expect(plan.relativePath).toBeDefined();
        writtenRelativePaths.push(plan.relativePath!);
      }
    }

    const report = await runHarnessAudit(root);
    expect(report.findings).toEqual([]);

    // Flow 310 (W2) T13: the "scanned clean" promise is vacuous if the
    // codex/kiro/opencode files this test just wrote were never actually
    // discovered by the agent-definitions surface in the first place (a
    // discovery gap reports zero findings for the same reason an audit of an
    // empty directory does). Assert the coverage actually saw every file
    // this test wrote, not just that nothing bad was found in whatever it
    // did see.
    for (const surface of report.surfaces) {
      expect(surface.status).not.toBe("error");
    }
    const agentDefinitionsSurface = report.surfaces.find((s) => s.surface === "agent-definitions");
    expect(agentDefinitionsSurface).toBeDefined();
    expect(agentDefinitionsSurface!.status).toBe("scanned");
    for (const relativePath of writtenRelativePaths) {
      expect(agentDefinitionsSurface!.pathsScanned).toContain(relativePath);
    }
  });
});

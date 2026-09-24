// Flow 310 (W2), T7: export.ts tests — AC4 (registry-backed support level,
// never a second hand-written table), the create/update/unchanged/
// refuse-unmanaged/dry-run lifecycle `planAgentExport`/`writeAgentExport`
// implement, and the every-bundled-agent-x-every-host-runtime guard (AC3/
// AC7 applied to the exporter's own output, not just compile.ts's).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { loadAgentCatalog } from "./catalog";
import {
  agentExportSupport,
  defaultAgentSupportLookup,
  planAgentExport,
  removeManagedAgentExports,
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
  name: "code-explorer",
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
    expect(plan.relativePath).toBe(".metaproject/agents-export/opencode/code-explorer.md");
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
    expect(plan.relativePath).toBe(".claude/agents/code-explorer.md");
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(true);
    expect(readFileSync(path.join(root, ".claude/agents/code-explorer.md"), "utf8")).toBe(plan.content as string);
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
    expect(readFileSync(path.join(root, ".claude/agents/code-explorer.md"), "utf8")).toContain("A different description now.");
  });

  test("refuse-unmanaged: an existing file with no keryx-managed sentinel is never overwritten", async () => {
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "code-explorer.md"), "# hand-authored, not keryx's\n", "utf8");
    const plan = await planAgentExport(root, DEFINITION, "claude");
    expect(plan.action).toBe("refuse-unmanaged");
    expect(plan.reason).toBeDefined();
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(false);
    expect(readFileSync(path.join(root, ".claude", "agents", "code-explorer.md"), "utf8")).toBe("# hand-authored, not keryx's\n");
  });

  test("dry-run never writes, even for a create/update plan", async () => {
    const plan = await planAgentExport(root, DEFINITION, "claude");
    const { written } = await writeAgentExport(root, plan, { dryRun: true });
    expect(written).toBe(false);
    expect(readFileSync).toBeDefined(); // sanity: file truly absent
    expect(() => readFileSync(path.join(root, ".claude/agents/code-explorer.md"), "utf8")).toThrow();
  });

  test("keryx-shell plans compiled-only with no file and a KeryxShellCompileResult", async () => {
    const plan = await planAgentExport(root, DEFINITION, "keryx-shell");
    expect(plan.action).toBe("compiled-only");
    expect(plan.relativePath).toBeUndefined();
    expect(plan.content).toBeUndefined();
    expect(plan.keryxShell?.target).toBe("keryx-shell");
    expect(plan.keryxShell?.input.label).toBe("code-explorer");
    expect(plan.droppedTools).toEqual([]);
    const { written } = await writeAgentExport(root, plan);
    expect(written).toBe(false);
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
    expect(removed).toEqual([".claude/agents/code-explorer.md"]);
    expect(() => readFileSync(path.join(root, ".claude/agents/code-explorer.md"), "utf8")).toThrow();
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
  for (const runtime of runtimes) {
    test(`${runtime}: every bundled agent's export contains the baseline verbatim once, the sentinel, and no model name`, async () => {
      for (const agent of catalog.agents) {
        const plan = await planAgentExport(root, agent.definition, runtime);
        expect(plan.content).toBeDefined();
        const content = plan.content!;
        const baselineOccurrences = content.split(PROMPT_DEFENSE_BASELINE).length - 1;
        expect(baselineOccurrences).toBe(1);
        expect(content).toContain("keryx-managed: keryx agents export (");
        // No literal model name — omitted entirely, or `model: inherit`/no
        // `model` field at all. `model_tier` VALUES ("light"/"standard"/
        // "deep") are not model names.
        expect(content).not.toMatch(/model\s*[:=]\s*"?(claude|gpt|opus|sonnet|haiku|gemini|o[0-9])/i);
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

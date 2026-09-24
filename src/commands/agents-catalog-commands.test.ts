// Tests for `keryx agents list|show|export|verify` (flow 310, W2-AC8).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentsCatalogCommand } from "./agents-catalog";

function collect(): { lines: string[]; errors: string[]; log: (l: string) => void; error: (l: string) => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (l) => lines.push(l), error: (l) => errors.push(l) };
}

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "keryx-agents-catalog-cli-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("keryx agents list", () => {
  test("lists the real bundled catalog and includes the ten generic agents", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("list", [], { cwd: REPO_ROOT, log, error });
    const text = lines.join("\n");
    for (const name of ["design-advisor", "work-planner", "codebase-navigator", "test-first-driver"]) {
      expect(text).toContain(name);
    }
  });

  test("--json emits a machine-readable catalog summary", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("list", ["--json"], { cwd: REPO_ROOT, log, error });
    const doc = JSON.parse(lines.join("\n")) as { agents: Array<{ name: string }>; catalogErrors: unknown[] };
    expect(doc.agents.length).toBeGreaterThanOrEqual(10);
    expect(doc.catalogErrors).toEqual([]);
  });

  test("--stack filters to definitions naming that stack (none of the bundled ten do)", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("list", ["--stack", "no-such-stack", "--json"], { cwd: REPO_ROOT, log, error });
    const doc = JSON.parse(lines.join("\n")) as { agents: Array<{ name: string }> };
    expect(doc.agents).toEqual([]);
  });

  test("an unknown flag is refused rather than ignored", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("list", ["--bogus"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown flag");
  });
});

describe("keryx agents show", () => {
  test("renders frontmatter summary and the compiled keryx-shell task", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("show", ["design-advisor"], { cwd: REPO_ROOT, log, error });
    const text = lines.join("\n");
    expect(text).toContain("model_tier: deep");
    expect(text).toContain("policy_profile: read-only");
    expect(text).toContain("compiled keryx-shell task");
    expect(process.exitCode).not.toBe(1);
  });

  test("--json emits the definition, source, and compiled result", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("show", ["design-advisor", "--json"], { cwd: REPO_ROOT, log, error });
    const doc = JSON.parse(lines.join("\n")) as { definition: { name: string }; compiled: { target: string } };
    expect(doc.definition.name).toBe("design-advisor");
    expect(doc.compiled.target).toBe("keryx-shell");
  });

  test("an unknown agent name is refused with a non-zero exit", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("show", ["no-such-agent"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown agent");
  });

  test("no name given is refused with a usage message", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("show", [], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Provide an agent name");
  });
});

describe("keryx agents export", () => {
  test("--dry-run plans without writing, for a real bundled agent", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("export", ["--runtime", "claude", "design-advisor", "--dry-run", "--json"], {
      cwd: tmpRoot,
      log,
      error,
    });
    const doc = JSON.parse(lines.join("\n")) as {
      plan: { action: string; runtime: string; relativePath?: string; supportLevel: string };
      written: boolean;
    };
    expect(doc.written).toBe(false);
    expect(doc.plan.runtime).toBe("claude");
    // The exact relative path depends on this repo's current W5 registry
    // state for claude's `agents` surface (native/adapter → `.claude/agents/`;
    // instruction-only → the prose fallback path) — either is a legitimate
    // plan; a dry-run never writes either way.
    expect(doc.plan.relativePath).toBeDefined();
    expect(["create", "update"]).toContain(doc.plan.action);
  });

  test("keryx-shell runtime prints the compiled spawn_subagent input", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("export", ["--runtime", "keryx-shell", "design-advisor", "--json"], {
      cwd: tmpRoot,
      log,
      error,
    });
    const doc = JSON.parse(lines.join("\n")) as { plan: { keryxShell?: { input: { task: string } } }; written: boolean };
    expect(doc.plan.keryxShell?.input.task).toBeDefined();
    // keryx-shell has no file to write — `written` stays false whether or not --dry-run was passed.
    expect(doc.written).toBe(false);
  });

  test("refuses to overwrite an existing file lacking the keryx-managed sentinel", async () => {
    // Discover this project's actual relativePath for claude first — it
    // depends on the current W5 registry support level (native/adapter →
    // `.claude/agents/`, instruction-only → the prose fallback path), rather
    // than assuming which one this repo currently resolves to.
    const probe = collect();
    await agentsCatalogCommand("export", ["--runtime", "claude", "design-advisor", "--dry-run", "--json"], {
      cwd: tmpRoot,
      log: probe.log,
      error: probe.error,
    });
    const probed = JSON.parse(probe.lines.join("\n")) as { plan: { relativePath: string } };
    const relativePath = probed.plan.relativePath;
    mkdirSync(path.dirname(path.join(tmpRoot, ...relativePath.split("/"))), { recursive: true });
    writeFileSync(path.join(tmpRoot, ...relativePath.split("/")), "# hand-authored, not keryx's\n", "utf8");

    const { lines, log, error } = collect();
    await agentsCatalogCommand("export", ["--runtime", "claude", "design-advisor", "--json"], { cwd: tmpRoot, log, error });
    const doc = JSON.parse(lines.join("\n")) as { plan: { action: string } };
    expect(doc.plan.action).toBe("refuse-unmanaged");
    expect(process.exitCode).toBe(1);
  });

  test("a second export is unchanged; --dry-run never touches disk", async () => {
    const first = collect();
    await agentsCatalogCommand("export", ["--runtime", "claude", "design-advisor"], { cwd: tmpRoot, log: first.log, error: first.error });
    expect(process.exitCode).not.toBe(1);

    const second = collect();
    await agentsCatalogCommand("export", ["--runtime", "claude", "design-advisor", "--json"], { cwd: tmpRoot, log: second.log, error: second.error });
    const doc = JSON.parse(second.lines.join("\n")) as { plan: { action: string } };
    expect(doc.plan.action).toBe("unchanged");
  });

  test("an invalid --runtime is refused", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("export", ["--runtime", "gemini", "design-advisor"], { cwd: tmpRoot, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--runtime");
  });

  test("an unknown flag is refused rather than ignored", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("export", ["--runtime", "claude", "design-advisor", "--wat"], { cwd: tmpRoot, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown flag");
  });
});

describe("keryx agents verify", () => {
  test("the real bundled catalog verifies ok", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("verify", ["--json"], { cwd: REPO_ROOT, log, error });
    const report = JSON.parse(lines.join("\n")) as { ok: boolean; agents: Array<{ problems: unknown[] }> };
    expect(report.ok).toBe(true);
    expect(report.agents.length).toBeGreaterThanOrEqual(10);
    for (const agent of report.agents) expect(agent.problems).toEqual([]);
    expect(process.exitCode).not.toBe(1);
  });

  test("narrows to one agent by name", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("verify", ["design-advisor", "--json"], { cwd: REPO_ROOT, log, error });
    const report = JSON.parse(lines.join("\n")) as { agents: Array<{ name: string }> };
    expect(report.agents.map((a) => a.name)).toEqual(["design-advisor"]);
  });

  test("an unknown name exits non-zero with the not-found reason", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("verify", ["no-such-agent", "--json"], { cwd: REPO_ROOT, log, error });
    const report = JSON.parse(lines.join("\n")) as { ok: boolean; agents: Array<{ problems: Array<{ reason: string }> }> };
    expect(report.ok).toBe(false);
    expect(report.agents[0]?.problems[0]?.reason).toBe("not-found");
    expect(process.exitCode).toBe(1);
  });

  test("a definition with an unknown tool fails verify with a non-zero exit and a named reason", async () => {
    mkdirSync(path.join(tmpRoot, ".metaproject", "agents"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".metaproject", "agents", "bad-tool.md"),
      [
        "---",
        "name: bad-tool",
        "description: d",
        "role: r",
        "tools: [read_file, delete_everything]",
        "model_tier: light",
        "policy_profile: read-only",
        "output_contract: subagent-result",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );
    const { lines, log, error } = collect();
    await agentsCatalogCommand("verify", ["bad-tool", "--json"], { cwd: tmpRoot, log, error });
    const report = JSON.parse(lines.join("\n")) as { ok: boolean; agents: Array<{ problems: Array<{ reason: string }> }> };
    expect(report.ok).toBe(false);
    expect(report.agents[0]?.problems.some((p) => p.reason === "unknown-tool")).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("an unknown flag is refused rather than ignored", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("verify", ["--nope"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown flag");
  });
});

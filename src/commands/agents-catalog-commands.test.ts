// Tests for `keryx agents list|show|export|verify` (flow 310, W2-AC8).
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EvalSpecFile } from "../gdskills/governance/eval";
import { buildGateReadyReport } from "../gdskills/governance/__fixtures__/gate-ready-report";
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
  // Flow 317: the trials=10 honest DeepSeek judge gate run cleared `python`
  // and `go` (now `stability: "stable"`), each shipping a generated
  // `<id>-code-auditor` / `<id>-build-fixer` pair. `ts-js-node` dropped out
  // (`no-ts-ignore-suppression` passRate 0.6 < 0.8 at the higher trial
  // count — the marginal-at-the-floor fragility flow 316 review round 1
  // predicted) and its pair was removed; `react` stays `experimental` and
  // ships none. Flow 318 (Wave 4 batch 2) briefly added `angular`, `mobx`
  // (design-decision-only, never a real pair — M1), and `nestjs` to the
  // gate-cleared set at various points, but PR #719's review rounds found
  // their positive trigger prompts were trigger-prefix near-copies or
  // scorer-avoidant phrasing rather than genuinely independent requests.
  // Rewritten honestly and never iterated against the router across two
  // review rounds, the FINAL honest gate re-run demoted all three back to
  // `experimental` (see each pack's own `agent-refs.json` `note` for the
  // specific failing skill/scenario). The real, un-stubbed CLI path reports
  // zero problems across the whole catalog, and exactly those four
  // generated agent names (go + python) are present.
  test("the real bundled catalog verifies ok with zero problems (only python and go are gate-cleared with a generated pair; flow 318)", async () => {
    const { lines, log, error } = collect();
    await agentsCatalogCommand("verify", ["--json"], { cwd: REPO_ROOT, log, error });
    const report = JSON.parse(lines.join("\n")) as {
      ok: boolean;
      agents: Array<{ name: string; problems: Array<{ reason: string }> }>;
    };
    expect(report.agents.length).toBeGreaterThanOrEqual(9);
    const withProblems = report.agents.filter((agent) => agent.problems.length > 0);
    expect(withProblems).toEqual([]);
    expect(report.ok).toBe(true);
    const generatedNames = report.agents
      .filter((agent) => agent.name.endsWith("-code-auditor") || agent.name.endsWith("-build-fixer"))
      .map((agent) => agent.name)
      .sort();
    expect(generatedNames).toEqual(["go-build-fixer", "go-code-auditor", "python-build-fixer", "python-code-auditor"]);
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

describe("keryx agents generate", () => {
  // `generate` always resolves the bundled agents/stacks tree via
  // `defaultBundledRoot()` (the same real-tree resolution every other
  // subcommand's bundled reads use) — it is not `cwd`-relocatable the way
  // `.metaproject/agents` project reads are, EXCEPT through the injectable
  // `bundledRoot` seam on `AgentsCatalogDeps` (flow 314 T13a), which exists
  // specifically so a test can point `generate` at an isolated fixture tree.
  //
  // Flow 316: the honest DeepSeek judge gate run cleared `react` and
  // `ts-js-node`; `go` and `python` still fail it, so `generate --stack go`
  // refuses with `stack-pack-not-gate-cleared` on the real tree. The three
  // tests below build their own isolated, gate-cleared fixture pack (the
  // same pack-level
  // `{ schemaVersion, reports: [...] }` eval-document shape
  // `checkStackPackGateCleared`/`checkStablePackGate` require — see
  // `verify.test.ts`'s "R1-4" fixture) so this behavior is verified
  // independent of which real pack, if any, happens to be gate-cleared.
  const REAL_BUNDLED_AGENTS_DIR = path.join(REPO_ROOT, "src", "gdskills", "bundled", "agents");

  let fixtureRoot: string;
  let fixtureBundledRoot: string;
  let fixtureAgentsDir: string;
  const FIXTURE_STACK_ID = "fixture-lang";

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "keryx-agents-generate-fixture-"));
    // `generate` resolves `<bundledRoot>/agents` and `<bundledRoot>/agents/../stacks`
    // (i.e. `<bundledRoot>/stacks`) — the same two-subdirectory shape as the
    // real `src/gdskills/bundled` tree — so the injected `bundledRoot` must
    // itself be the parent of both, not the agents directory directly.
    fixtureBundledRoot = path.join(fixtureRoot, "bundled");
    fixtureAgentsDir = path.join(fixtureBundledRoot, "agents");
    const stacksRoot = path.join(fixtureBundledRoot, "stacks");
    const packDir = path.join(stacksRoot, FIXTURE_STACK_ID);
    const skillDir = path.join(packDir, "skills", "fixture-skill");
    mkdirSync(fixtureAgentsDir, { recursive: true });
    mkdirSync(path.join(packDir, "governance"), { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      path.join(packDir, "pack.json"),
      JSON.stringify({
        id: FIXTURE_STACK_ID,
        family: "language",
        modules: [],
        stability: "stable",
        // R1 review, PR #719 (M2): both buckets must be non-empty here — the
        // generator now omits a persona entirely when its matching skill
        // bucket is empty, and several tests below (symlink refusal on the
        // fixer's own target, "writing both generated files") depend on
        // both the auditor AND the fixer actually being generated.
        skills: { review: ["fixture-skill"], "build-fix": ["fixture-skill"] },
        agentProfile: {
          displayName: "Fixture Lang",
          auditFocus: ["fixture risk pattern"],
          buildCommands: ["fixture build"],
          fixGuardrails: ["never do the fixture-bad thing"],
        },
      }),
      "utf8",
    );
    // Flow 316 fix1 (R1-3): the gate ALWAYS re-scores trigger scenarios live
    // against the skill's own CURRENT SKILL.md frontmatter — its
    // `triggers:` list is seeded from the same authored positive prompt so
    // honest routing selects it (single-letter placeholders never route
    // anywhere).
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: fixture skill\ntriggers:\n  - do the fixture task\n---\n\nBody.\n",
      "utf8",
    );
    const evalSpec: EvalSpecFile = {
      triggers: { positive: ["do the fixture task"], negative: ["something entirely unrelated"] },
      scenarios: [
        { id: "behavior-1", prompt: "Do the thing", strictness: "high", expected_behavior: [{ grader: "contains", value: "thing" }] },
      ],
    };
    writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
    // Flow 316: an allowlisted runner, per-trial `trialRecords`, and a
    // `catalogDigest` matching the real bundled catalog — everything the
    // hardened gate now requires, on top of the provenance this fixture
    // already carried.
    const report = buildGateReadyReport({
      packId: FIXTURE_STACK_ID,
      skillName: "fixture-skill",
      skillDir,
      evalSpec,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("--check reports no drift for a gate-cleared fixture pack once its pair has been generated", async () => {
    const written = collect();
    await agentsCatalogCommand("generate", ["--stack", FIXTURE_STACK_ID, "--json"], {
      cwd: REPO_ROOT,
      bundledRoot: fixtureBundledRoot,
      log: written.log,
      error: written.error,
    });
    expect(process.exitCode).not.toBe(1);

    const { lines, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", FIXTURE_STACK_ID, "--check", "--json"], {
      cwd: REPO_ROOT,
      bundledRoot: fixtureBundledRoot,
      log,
      error,
    });
    const doc = JSON.parse(lines.join("\n")) as {
      stack: string;
      check: boolean;
      files: Array<{ fileName: string; changed: boolean; existed: boolean }>;
    };
    expect(doc.stack).toBe(FIXTURE_STACK_ID);
    expect(doc.files).toHaveLength(2);
    expect(doc.files.map((f) => f.fileName).sort()).toEqual([
      `${FIXTURE_STACK_ID}-build-fixer.md`,
      `${FIXTURE_STACK_ID}-code-auditor.md`,
    ]);
    for (const file of doc.files) {
      expect(file.existed).toBe(true);
      expect(file.changed).toBe(false);
    }
    expect(process.exitCode).not.toBe(1);
  });

  test("--check exits 1 and reports drift when a generated file was hand-edited, without writing", async () => {
    const written = collect();
    await agentsCatalogCommand("generate", ["--stack", FIXTURE_STACK_ID, "--json"], {
      cwd: REPO_ROOT,
      bundledRoot: fixtureBundledRoot,
      log: written.log,
      error: written.error,
    });
    expect(process.exitCode).not.toBe(1);

    const filePath = path.join(fixtureAgentsDir, `${FIXTURE_STACK_ID}-code-auditor.md`);
    const original = readFileSync(filePath, "utf8");
    writeFileSync(filePath, `${original}\n<!-- hand edit -->\n`, "utf8");

    const { lines, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", FIXTURE_STACK_ID, "--check", "--json"], {
      cwd: REPO_ROOT,
      bundledRoot: fixtureBundledRoot,
      log,
      error,
    });
    const doc = JSON.parse(lines.join("\n")) as { files: Array<{ fileName: string; changed: boolean }> };
    const auditor = doc.files.find((f) => f.fileName === `${FIXTURE_STACK_ID}-code-auditor.md`);
    expect(auditor?.changed).toBe(true);
    expect(process.exitCode).toBe(1);
    // --check never writes — the hand edit must still be on disk.
    expect(readFileSync(filePath, "utf8")).toBe(`${original}\n<!-- hand edit -->\n`);
    process.exitCode = 0;
  });

  test("writing (no --check) restores a hand-edited file back to the generated content", async () => {
    const written = collect();
    await agentsCatalogCommand("generate", ["--stack", FIXTURE_STACK_ID, "--json"], {
      cwd: REPO_ROOT,
      bundledRoot: fixtureBundledRoot,
      log: written.log,
      error: written.error,
    });
    expect(process.exitCode).not.toBe(1);

    const filePath = path.join(fixtureAgentsDir, `${FIXTURE_STACK_ID}-build-fixer.md`);
    const original = readFileSync(filePath, "utf8");
    writeFileSync(filePath, `${original}\n<!-- hand edit -->\n`, "utf8");

    const { lines, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", FIXTURE_STACK_ID, "--json"], {
      cwd: REPO_ROOT,
      bundledRoot: fixtureBundledRoot,
      log,
      error,
    });
    const doc = JSON.parse(lines.join("\n")) as { files: Array<{ fileName: string; changed: boolean }> };
    const fixer = doc.files.find((f) => f.fileName === `${FIXTURE_STACK_ID}-build-fixer.md`);
    expect(fixer?.changed).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  test("an invalid --stack id is refused", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "Not-Valid!"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--stack");
  });

  test("no --stack at all is refused", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", [], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--stack");
  });

  test("a --stack naming a pack that does not exist is refused", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "no-such-pack"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("no-such-pack");
  });

  test("a --stack pack with no agentProfile is refused (e.g. mobx, which is deliberately not gated for generation)", async () => {
    // mobx is a real bundled stack directory with no `agentProfile` block
    // (W2 §"Initial catalogue": it extends react rather than getting its
    // own generated pair) — a real, on-disk negative case rather than a
    // synthetic one. R1 review round 2 (PR #719, N-M1) also demoted mobx's
    // own gate status to "experimental" — a SECOND, independent reason
    // generation refuses it now, checked first in the CLI's own order. This
    // test cares that generation refuses and produces no pair either way,
    // not which of the two refusal reasons wins on the current tree.
    const mobxPackPath = path.join(REPO_ROOT, "src", "gdskills", "bundled", "stacks", "mobx", "pack.json");
    if (!existsSync(mobxPackPath)) return; // skip if this repo's stack layout ever changes
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "mobx"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    const message = errors.join("\n");
    expect(message.includes("agentProfile") || message.includes("stack-pack-not-gate-cleared")).toBe(true);
  });

  test("an unknown flag is refused rather than ignored", async () => {
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "go", "--bogus"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown flag");
  });

  test("a real, on-disk experimental pack (ts-js-node) is refused with stack-pack-not-gate-cleared, and no generated files exist", async () => {
    // Flow 317: ts-js-node dropped to `experimental` at trials=10
    // (`no-ts-ignore-suppression` passRate 0.6 < 0.8 — see
    // ts-js-node/agent-refs.json's note); this proves `generate` itself
    // refuses to create a pair for it.
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "ts-js-node"], { cwd: REPO_ROOT, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("stack-pack-not-gate-cleared");
    expect(existsSync(path.join(REAL_BUNDLED_AGENTS_DIR, "ts-js-node-code-auditor.md"))).toBe(false);
    expect(existsSync(path.join(REAL_BUNDLED_AGENTS_DIR, "ts-js-node-build-fixer.md"))).toBe(false);
  });

  test("a real, on-disk stable/gate-cleared pack (go) regenerates byte-identically with --check", async () => {
    // Flow 317: go cleared the trials=10 honest DeepSeek judge gate (the
    // no-nolint-suppression scenario defect fix plus the answer-in-text
    // runner note together fixed both go-build-fix and go-testing) and now
    // ships its generated pair (written by `bun ./src/cli.ts agents
    // generate --stack go`) — `--check` against the real tree must report
    // no drift.
    const { lines, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "go", "--check", "--json"], { cwd: REPO_ROOT, log, error });
    const doc = JSON.parse(lines.join("\n")) as { files: Array<{ fileName: string; changed: boolean; existed: boolean }> };
    expect(process.exitCode).not.toBe(1);
    for (const file of doc.files) {
      expect(file.existed).toBe(true);
      expect(file.changed).toBe(false);
    }
  });
});

describe("keryx agents generate — gate enforcement on fixture packs (flow 314 T13a)", () => {
  // Isolated from the real bundled tree via the `bundledRoot` deps seam
  // (`AgentsCatalogDeps.bundledRoot`) added for exactly this purpose — these
  // fixture packs never touch `src/gdskills/bundled/**`, so they need no
  // hand-edit/restore dance and cannot race other test files that scan the
  // real tree.
  function makeFixtureStack(
    stability: "stable" | "experimental",
    id = "fixture-lang",
  ): { bundledRoot: string; packDir: string; agentsDir: string } {
    const bundledRoot = path.join(tmpRoot, "bundled");
    const agentsDir = path.join(bundledRoot, "agents");
    const packDir = path.join(bundledRoot, "stacks", id);
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(path.join(packDir, "governance"), { recursive: true });
    writeFileSync(
      path.join(packDir, "pack.json"),
      JSON.stringify(
        {
          id,
          family: "language",
          modules: [],
          stability,
          // R1 review, PR #719 (M2): both buckets non-empty so every test in
          // this describe block that expects a full auditor+fixer pair
          // (byte-identical regeneration, symlink refusal on the fixer's own
          // target) still has both to work with — the generator now omits a
          // persona entirely when its matching bucket is empty.
          skills: { review: ["fixture-skill"], "build-fix": ["fixture-skill"] },
          agentProfile: {
            displayName: "Fixture Lang",
            auditFocus: ["risk one"],
            buildCommands: ["fixture build"],
            fixGuardrails: ["never do the bad thing"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    return { bundledRoot, packDir, agentsDir };
  }

  // R1-4 (review round 1, PR #692): the stack-pack gate now requires the
  // pack-level `{ schemaVersion, reports: EvalReport[] }` eval document form
  // — the legacy single-report shape this fixture used to build no longer
  // clears the gate. Builds a real `skills/fixture-skill/SKILL.md` +
  // `evals.json` and a `governance/eval.json` pack-level document whose one
  // report clears every requirement `checkSkillReportForPackGate` enforces
  // (see `src/agents/verify.test.ts`'s matching fixture for the same shape).
  function writePassingEval(packDir: string, packId = "fixture-lang"): void {
    const skillDir = path.join(packDir, "skills", "fixture-skill");
    mkdirSync(skillDir, { recursive: true });
    // Flow 316 fix1 (R1-3): the gate ALWAYS re-scores trigger scenarios live
    // against the skill's own CURRENT SKILL.md frontmatter — its
    // `triggers:` list is seeded from the same authored positive prompt so
    // honest routing selects it (single-letter placeholders never route
    // anywhere).
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: fixture skill\ntriggers:\n  - do the fixture task\n---\n\nBody.\n",
      "utf8",
    );
    const evalSpec: EvalSpecFile = {
      triggers: { positive: ["do the fixture task"], negative: ["something entirely unrelated"] },
      scenarios: [
        { id: "behavior-1", prompt: "Do the thing", strictness: "high", expected_behavior: [{ grader: "contains", value: "thing" }] },
      ],
    };
    writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
    // Flow 316: an allowlisted runner, per-trial `trialRecords`, and a
    // `catalogDigest` matching the real bundled catalog.
    const report = buildGateReadyReport({ packId, skillName: "fixture-skill", skillDir, evalSpec, recordedAt: "2026-01-01T00:00:00.000Z" });
    const doc = { schemaVersion: "1.0.0", reports: [report] };
    writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify(doc, null, 2), "utf8");
  }

  test("refuses an experimental fixture pack: named reason, no files written", async () => {
    const { bundledRoot, agentsDir } = makeFixtureStack("experimental");
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("stack-pack-not-gate-cleared");
    expect(existsSync(path.join(agentsDir, "fixture-lang-code-auditor.md"))).toBe(false);
    expect(existsSync(path.join(agentsDir, "fixture-lang-build-fixer.md"))).toBe(false);
  });

  test("refuses a stable fixture pack whose eval gate fails (no governance/eval.json): named reason, no files written", async () => {
    const { bundledRoot, agentsDir } = makeFixtureStack("stable");
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("stack-pack-not-gate-cleared");
    expect(existsSync(path.join(agentsDir, "fixture-lang-code-auditor.md"))).toBe(false);
    expect(existsSync(path.join(agentsDir, "fixture-lang-build-fixer.md"))).toBe(false);
  });

  test("--check on a non-cleared pack refuses the same way as the write path (documented choice — see agents-catalog.ts's generateCommand)", async () => {
    const { bundledRoot } = makeFixtureStack("experimental");
    const { lines, errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "fixture-lang", "--check"], { cwd: REPO_ROOT, bundledRoot, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("stack-pack-not-gate-cleared");
    expect(lines.join("\n")).toBe(""); // no report of "no generated pair expected" — a plain refusal instead
  });

  test("succeeds for a gate-cleared fixture pack, writing both generated files", async () => {
    const { bundledRoot, packDir, agentsDir } = makeFixtureStack("stable");
    writePassingEval(packDir);
    const { lines, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "fixture-lang", "--json"], { cwd: REPO_ROOT, bundledRoot, log, error });
    expect(process.exitCode).not.toBe(1);
    const doc = JSON.parse(lines.join("\n")) as { files: Array<{ fileName: string; changed: boolean }> };
    expect(doc.files.map((f) => f.fileName).sort()).toEqual(["fixture-lang-build-fixer.md", "fixture-lang-code-auditor.md"]);
    expect(existsSync(path.join(agentsDir, "fixture-lang-code-auditor.md"))).toBe(true);
    expect(existsSync(path.join(agentsDir, "fixture-lang-build-fixer.md"))).toBe(true);
  });

  // R1-6 (review round 1, PR #692): `pack.json`'s own `id` is untrusted — it
  // must equal the `--stack`/directory name (`gen-escape.ts`'s probe: a
  // pack.json `id` of `"../escaped"` under `stacks/go` used to write
  // `../escaped-code-auditor.md`/`../escaped-build-fixer.md` OUTSIDE the
  // bundled agents directory entirely).
  describe("R1-6: pack.json id trust and write containment", () => {
    test("a pack.json id that disagrees with the --stack directory name is refused, and nothing is written", async () => {
      const { bundledRoot, packDir, agentsDir } = makeFixtureStack("stable");
      writePassingEval(packDir);
      // Overwrite the id AFTER writePassingEval so the eval report's
      // skillId ("fixture-lang/fixture-skill") still matches what the gate
      // reads — the mismatch under test is purely pack.json "id" vs. the
      // "--stack fixture-lang" directory name, not the eval report.
      const raw = JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8")) as Record<string, unknown>;
      raw.id = "not-fixture-lang";
      writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(raw), "utf8");
      const { errors, log, error } = collect();
      await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("fixture-lang");
      expect(existsSync(path.join(agentsDir, "not-fixture-lang-code-auditor.md"))).toBe(false);
      expect(existsSync(path.join(agentsDir, "fixture-lang-code-auditor.md"))).toBe(false);
    });

    test("a path-traversal pack.json id (gen-escape.ts's case) never writes outside the bundled agents directory", async () => {
      const { bundledRoot, packDir, agentsDir } = makeFixtureStack("stable");
      writePassingEval(packDir);
      const raw = JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8")) as Record<string, unknown>;
      raw.id = "../escaped";
      writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(raw), "utf8");
      const { log, error } = collect();
      await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
      expect(process.exitCode).toBe(1);
      // Nothing escaped: neither inside `agents/` nor one level up from it.
      expect(existsSync(path.join(agentsDir, "..", "escaped-code-auditor.md"))).toBe(false);
      expect(existsSync(path.join(agentsDir, "escaped-code-auditor.md"))).toBe(false);
    });

    test("a symlinked destination file is never written through", async () => {
      const { bundledRoot, packDir, agentsDir } = makeFixtureStack("stable");
      writePassingEval(packDir);
      const outsideTarget = path.join(tmpRoot, "outside-target.md");
      writeFileSync(outsideTarget, "should never be overwritten\n", "utf8");
      symlinkSync(outsideTarget, path.join(agentsDir, "fixture-lang-code-auditor.md"));
      const { errors, log, error } = collect();
      await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("symlink");
      expect(readFileSync(outsideTarget, "utf8")).toBe("should never be overwritten\n");
      expect(lstatSync(path.join(agentsDir, "fixture-lang-code-auditor.md")).isSymbolicLink()).toBe(true);
    });

    // R2-3 (review round 2, PR #692): the auditor and fixer targets used to be
    // validated and written inside the same per-file loop, so a symlinked
    // FIXER target (checked second) left the auditor already written to disk
    // before the refusal fired — a half-written pair with exit 1. Both
    // targets must now be validated in a first pass before either is
    // written.
    test("R2-3: a symlinked fixer target refuses the whole pair — no auditor file is written either", async () => {
      const { bundledRoot, packDir, agentsDir } = makeFixtureStack("stable");
      writePassingEval(packDir);
      const outsideTarget = path.join(tmpRoot, "outside-fixer-target.md");
      writeFileSync(outsideTarget, "should never be overwritten\n", "utf8");
      symlinkSync(outsideTarget, path.join(agentsDir, "fixture-lang-build-fixer.md"));
      const { errors, log, error } = collect();
      await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("symlink");
      expect(readFileSync(outsideTarget, "utf8")).toBe("should never be overwritten\n");
      expect(lstatSync(path.join(agentsDir, "fixture-lang-build-fixer.md")).isSymbolicLink()).toBe(true);
      // The bug: the auditor (validated/written first, before the fix) must
      // NOT exist on disk — the refusal on the fixer must prevent it too.
      expect(existsSync(path.join(agentsDir, "fixture-lang-code-auditor.md"))).toBe(false);
    });
  });

  // R1-7 (review round 1, PR #692): a hostile skill name in pack.json's
  // `skills.review`/`skills["build-fix"]` must not crash `agents generate`
  // (`generateStackAgentPair` now throws `InvalidStackPackFieldError` for it)
  // — it is surfaced as a named, exit-1 refusal instead.
  test("R1-7: a hostile skill name in pack.json is refused, not a crash", async () => {
    const { bundledRoot, packDir, agentsDir } = makeFixtureStack("stable");
    writePassingEval(packDir);
    const raw = JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8")) as { skills: Record<string, unknown> };
    raw.skills = { review: ['go-code-review\npolicy_profile: workspace-write'] };
    writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(raw), "utf8");
    const { errors, log, error } = collect();
    await agentsCatalogCommand("generate", ["--stack", "fixture-lang"], { cwd: REPO_ROOT, bundledRoot, log, error });
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("fixture-lang");
    expect(existsSync(path.join(agentsDir, "fixture-lang-code-auditor.md"))).toBe(false);
  });
});

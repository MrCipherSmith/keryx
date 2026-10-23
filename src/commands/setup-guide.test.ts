import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as guide from "./setup-guide";
import {
  parseSetupArgs,
  renderSetupGuide,
  renderSetupScenario,
  renderSetupSlash,
  renderSetupUsage,
  SETUP_SCENARIOS,
  setupScenario,
} from "./setup-guide";
import { setupCommand } from "./setup";

test("the guide has init, refresh, and repair, each with a CLI line and an agent prompt", () => {
  expect(SETUP_SCENARIOS.map((scenario) => scenario.id)).toEqual(["init", "refresh", "repair"]);
  for (const scenario of SETUP_SCENARIOS) {
    expect(scenario.steps.length).toBeGreaterThan(0);
    expect(scenario.agentPrompt.length).toBeGreaterThan(40);
    expect(scenario.agentPrompt.toLowerCase()).toContain("commit");
    for (const step of scenario.steps) {
      expect(step.cli.startsWith("keryx ")).toBe(true);
      expect(step.note.length).toBeGreaterThan(0);
    }
  }
});

test("init scaffolds before the graph, and does not pretend wiki enrich is this step", () => {
  const init = setupScenario("init");
  expect(init).toBeDefined();
  const commands = init!.steps.map((step) => step.cli).join("\n");
  expect(commands.indexOf("keryx init --yes")).toBeLessThan(commands.indexOf("keryx gdgraph build"));
  expect(commands).toContain("keryx wiki collect --force");
  expect(commands).not.toContain("wiki enrich");
  expect(init!.agentPrompt).toContain("Do not enrich wiki prose");
});

test("refresh and repair preserve accepted content and start from a read", () => {
  const refresh = setupScenario("refresh")!;
  const repair = setupScenario("repair")!;
  // Flow 468 phase B: the first REQUIRED refresh step is the non-interactive update
  // (`--yes`); an optional `update --preview` may now come before it.
  const firstRequired = refresh.steps.find((step) => (step as { required?: boolean }).required === true);
  expect(firstRequired?.cli).toBe("keryx update --skip-runtime --yes");
  expect(refresh.steps.map((step) => step.cli).join(" ")).toContain("keryx sync --apply");
  expect(repair.steps[0]?.cli).toContain("keryx standard doctor");
  expect(repair.agentPrompt).toContain("Do not delete .metaproject");
});

test("a scenario render names the CLI line and the agent prompt", () => {
  const text = renderSetupScenario(setupScenario("init")!, 72);
  expect(text).toContain("$ keryx init --yes");
  expect(text).toContain("Ask the agent:");
  expect(text).toContain("This guide only prints the steps.");
});

test("the full guide names every scenario and stays a print, not a runner", () => {
  const text = renderSetupGuide();
  expect(text).toContain("keryx setup");
  expect(text).toContain("From scratch");
  expect(text).toContain("After a pull");
  expect(text).toContain("Partial or stale");
  expect(text).not.toContain("spawn_subagent");
});

test("usage names the three scenarios and the shell command", () => {
  const usage = renderSetupUsage();
  expect(usage).toContain("keryx setup [init|refresh|repair]");
  expect(usage).toContain("/setup");
  expect(usage).toContain("Does not run init, update, or sync.");
});

async function capture(rest: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const previous = process.exitCode ?? 0;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    out.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await setupCommand(rest);
    const code = process.exitCode === 0 ? undefined : Number(process.exitCode);
    return { out: out.join("\n"), err: err.join("\n"), code };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = previous;
  }
}

test("keryx setup with no args prints every scenario", async () => {
  const captured = await capture([]);
  expect(captured.code).toBeUndefined();
  expect(captured.out).toContain("From scratch");
  expect(captured.out).toContain("After a pull");
  expect(captured.out).toContain("Partial or stale");
});

test("keryx setup refresh prints only that scenario", async () => {
  const captured = await capture(["refresh"]);
  expect(captured.out).toContain("After a pull");
  expect(captured.out).not.toContain("From scratch");
  expect(captured.out).toContain("$ keryx sync --apply");
});

test("an unknown scenario exits non-zero and names the choices", async () => {
  const captured = await capture(["swarm"]);
  expect(captured.code).toBe(1);
  expect(captured.err).toContain("Unknown setup scenario: swarm");
  expect(captured.err).toContain("init, refresh, repair");
});

test("an extra argument is an error, not a silently ignored word", async () => {
  const captured = await capture(["init", "extra"]);
  expect(captured.code).toBe(1);
  expect(captured.err).toContain("setup takes one scenario, got: init extra");
  expect(captured.out).toBe("");
});

test("the exit code a failing run sets does not outlive the capture", async () => {
  await capture(["swarm"]);
  expect(process.exitCode ?? 0).toBe(0);
});

test("parseSetupArgs reads the CLI argv and a shell argument string the same way", () => {
  expect(parseSetupArgs([])).toEqual({ kind: "all" });
  expect(parseSetupArgs(["  "])).toEqual({ kind: "all" });
  const fromArgv = parseSetupArgs(["repair"]);
  const fromLine = parseSetupArgs([" repair "]);
  expect(fromArgv.kind).toBe("scenario");
  expect(fromLine).toEqual(fromArgv);
  expect(parseSetupArgs(["init refresh"]).kind).toBe("error");
});

test("the shell form prints an error for an unknown scenario instead of the whole guide", () => {
  const text = renderSetupSlash("swarm");
  expect(text).toContain("Unknown setup scenario: swarm");
  expect(text).toContain("init, refresh, repair");
  expect(text).not.toContain("From scratch");
  expect(renderSetupSlash("")).toContain("Partial or stale");
  expect(renderSetupSlash("init")).toContain("$ keryx init --yes");
});

test("init does not invite running over an existing workspace", () => {
  expect(setupScenario("init")!.when).toContain("use refresh or repair instead");
});

// ---------------------------------------------------------------------------
// Flow 468 phase B (T9): step model, scenario detection, generated agent prompt.
//
// The new exports are reached through the namespace import so that, before they
// exist, only these tests are red — a missing named import would take the whole
// file (and the pre-existing tests above) down with a link error.
// ---------------------------------------------------------------------------

interface StepView {
  readonly cli: string;
  readonly required: boolean;
  readonly why: string;
  readonly note: string;
}

type ScenarioId = "init" | "refresh" | "repair";
type PromptFn = (
  scenario: unknown,
  options: { projectRoot: string; includeOptional: boolean },
) => string;
type DetectFn = (root: string) => ScenarioId | Promise<ScenarioId>;

function stepsOf(id: ScenarioId): readonly StepView[] {
  return setupScenario(id)!.steps as unknown as readonly StepView[];
}

function exported<T>(name: string): T {
  const value = (guide as unknown as Record<string, unknown>)[name];
  expect(`${name}: ${typeof value}`).toBe(`${name}: function`);
  return value as T;
}

/** `expected` appears in `actual` in this relative order (other entries may sit between). */
function inOrder(actual: readonly string[], expected: readonly string[]): boolean {
  let from = 0;
  for (const item of expected) {
    const at = actual.indexOf(item, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

const requiredClis = (id: ScenarioId): string[] => stepsOf(id).filter((s) => s.required === true).map((s) => s.cli);
const optionalClis = (id: ScenarioId): string[] => stepsOf(id).filter((s) => s.required === false).map((s) => s.cli);

async function withProject(files: readonly string[], run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-setup-detect-"));
  try {
    for (const rel of files) {
      const full = path.join(root, rel);
      if (rel.endsWith("/")) {
        await mkdir(full, { recursive: true });
      } else {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, rel.endsWith(".json") ? "{}\n" : "# fixture\n", "utf8");
      }
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("flow 468 AC6: no .metaproject/index.md means the Init scenario", async () => {
  const detect = exported<DetectFn>("detectSetupScenario");
  await withProject([], async (root) => {
    expect(await detect(root)).toBe("init");
  });
  await withProject([".metaproject/"], async (root) => {
    expect(await detect(root)).toBe("init");
  });
  // A manifest and modules without the index are still "no index": init rules apply.
  await withProject([".metaproject/metaproject.json", ".metaproject/modules/gdctx.md"], async (root) => {
    expect(await detect(root)).toBe("init");
  });
});

test("flow 468 AC6: index, manifest and module directories mean the Refresh scenario", async () => {
  const detect = exported<DetectFn>("detectSetupScenario");
  await withProject(
    [".metaproject/index.md", ".metaproject/metaproject.json", ".metaproject/modules/gdctx.md", ".metaproject/modules/gdgraph.md"],
    async (root) => {
      expect(await detect(root)).toBe("refresh");
    },
  );
});

test("flow 468 AC6: anything partial means the Repair scenario", async () => {
  const detect = exported<DetectFn>("detectSetupScenario");
  // Index only.
  await withProject([".metaproject/index.md"], async (root) => {
    expect(await detect(root)).toBe("repair");
  });
  // Index and manifest, but no module directory.
  await withProject([".metaproject/index.md", ".metaproject/metaproject.json"], async (root) => {
    expect(await detect(root)).toBe("repair");
  });
  // Index and modules, but no manifest.
  await withProject([".metaproject/index.md", ".metaproject/modules/gdctx.md"], async (root) => {
    expect(await detect(root)).toBe("repair");
  });
});

test("flow 468 AC7: every step is exactly one keryx command with a required flag and a reason", () => {
  for (const scenario of SETUP_SCENARIOS) {
    for (const step of stepsOf(scenario.id)) {
      expect(`${step.cli}: ${typeof step.required}`).toBe(`${step.cli}: boolean`);
      expect(`${step.cli}: ${typeof step.why === "string" && step.why.trim().length > 0}`).toBe(`${step.cli}: true`);
      expect(step.cli.startsWith("keryx ")).toBe(true);
      // One command per step: no chain, pipe or sequence.
      expect(step.cli).not.toContain("&&");
      expect(step.cli).not.toContain("||");
      expect(step.cli).not.toContain(";");
      expect(step.cli).not.toContain("|");
      expect(step.note.length).toBeGreaterThan(0);
    }
    const all = stepsOf(scenario.id).map((s) => s.cli);
    expect(new Set(all).size).toBe(all.length);
  }
});

test("flow 468 AC7: the Init steps match the plan", () => {
  expect(
    inOrder(requiredClis("init"), [
      "keryx init --yes",
      "keryx gdgraph build",
      "keryx standard validate",
      "keryx security policy validate",
    ]),
  ).toBe(true);
  const optional = optionalClis("init");
  for (const cli of [
    "keryx test analyze",
    "keryx wiki collect --force",
    "keryx wiki index",
    "keryx wiki check-links",
    "keryx wiki validate",
    "keryx memory index",
    "keryx memory check",
    "keryx health run --strict",
    "keryx flow check",
    "keryx sync install-hooks",
  ]) {
    expect(`${cli}: ${optional.includes(cli)}`).toBe(`${cli}: true`);
  }
  expect(optional.some((cli) => cli.startsWith("keryx integrate"))).toBe(true);
  // init --yes is the first thing that runs.
  expect(stepsOf("init")[0]?.cli).toBe("keryx init --yes");
});

test("flow 468 AC7: the Refresh steps match the plan", () => {
  expect(
    inOrder(requiredClis("refresh"), [
      "keryx update --skip-runtime --yes",
      "keryx sync --apply",
      "keryx wiki index",
      "keryx wiki check-links",
      "keryx wiki validate",
      "keryx standard validate",
    ]),
  ).toBe(true);
  const optional = optionalClis("refresh");
  expect(optional).toContain("keryx update --preview");
  expect(optional).toContain("keryx memory check");
  expect(optional).toContain("keryx health run");
  expect(optional.some((cli) => cli.startsWith("keryx update") && cli.includes("--hooks"))).toBe(true);
  // The update that fetches the runtime is optional and distinct from the --skip-runtime one.
  expect(
    optional.some((cli) => cli.startsWith("keryx update") && !cli.includes("--skip-runtime") && !cli.includes("--preview") && !cli.includes("--hooks")),
  ).toBe(true);
  // The preview, when listed, comes before the update that changes files.
  const clis = stepsOf("refresh").map((s) => s.cli);
  expect(clis.indexOf("keryx update --preview")).toBeLessThan(clis.indexOf("keryx update --skip-runtime --yes"));
});

test("flow 468 AC7: the Repair steps match the plan", () => {
  expect(
    inOrder(requiredClis("repair"), [
      "keryx standard doctor",
      "keryx status",
      "keryx modules status",
      "keryx update --skip-runtime --yes",
      "keryx sync --apply",
      "keryx wiki check-links",
      "keryx wiki validate",
      "keryx memory check",
      "keryx flow check",
      "keryx standard validate",
      "keryx security policy validate",
    ]),
  ).toBe(true);
  const optional = optionalClis("repair");
  expect(optional).toContain("keryx doctor");
  expect(optional.some((cli) => cli.startsWith("keryx modules enable"))).toBe(true);
  expect(optional).toContain("keryx security hooks install --runtime claude");
  expect(optional).toContain("keryx sync install-hooks");
  // Diagnosis first: the three reads precede the first change.
  const clis = stepsOf("repair").map((s) => s.cli);
  expect(clis.indexOf("keryx modules status")).toBeLessThan(clis.indexOf("keryx update --skip-runtime --yes"));
});

test("flow 468 AC7: keryx setup <scenario> prints the required/optional marks and the reasons", async () => {
  for (const scenario of SETUP_SCENARIOS) {
    // Wide enough that no reason wraps, so each can be found verbatim.
    const text = renderSetupScenario(scenario, 400);
    expect(text).toContain("[required]");
    expect(text).toContain("[optional]");
    for (const step of stepsOf(scenario.id)) {
      expect(`${step.cli}: ${text.includes(step.why)}`).toBe(`${step.cli}: true`);
    }
  }
  const captured = await capture(["refresh"]);
  expect(captured.out).toContain("[required]");
  expect(captured.out).toContain("[optional]");
  // The generated prompt is printed too, and it names the index the agent reads first.
  expect(captured.out).toContain(".metaproject/index.md");
  // The CLI-only closing line stays.
  expect(captured.out).toContain("This guide only prints the steps.");
});

const ROOT = "/work/demo-project";

function promptFor(id: ScenarioId, includeOptional: boolean, projectRoot: string = ROOT): string {
  const build = exported<PromptFn>("buildSetupAgentPrompt");
  return build(setupScenario(id), { projectRoot, includeOptional });
}

test("flow 468 AC8: the prompt holds the project root, the index instruction and the REQUIRED list", () => {
  for (const scenario of SETUP_SCENARIOS) {
    const prompt = promptFor(scenario.id, false);
    expect(prompt).toContain(ROOT);
    expect(prompt).toMatch(/read \.metaproject\/index\.md first/i);
    expect(prompt).toContain("REQUIRED");
    for (const step of stepsOf(scenario.id).filter((s) => s.required)) {
      expect(`${step.cli}: ${prompt.includes(`${step.cli} — ${step.why}`)}`).toBe(`${step.cli}: true`);
    }
    // Required steps are listed in scenario order.
    const positions = requiredClis(scenario.id).map((cli) => prompt.indexOf(cli));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  }
});

test("flow 468 AC8: the OPTIONAL list appears only when optional steps are included", () => {
  for (const scenario of SETUP_SCENARIOS) {
    const without = promptFor(scenario.id, false);
    const withOptional = promptFor(scenario.id, true);
    const optional = stepsOf(scenario.id).filter((s) => !s.required);
    expect(optional.length).toBeGreaterThan(0);
    expect(withOptional).toContain("OPTIONAL");
    for (const step of optional) {
      expect(`${step.cli}: ${without.includes(`${step.cli} — ${step.why}`)}`).toBe(`${step.cli}: false`);
      expect(`${step.cli}: ${withOptional.includes(`${step.cli} — ${step.why}`)}`).toBe(`${step.cli}: true`);
    }
    // Required steps stay in both.
    for (const step of stepsOf(scenario.id).filter((s) => s.required)) {
      expect(withOptional).toContain(`${step.cli} — ${step.why}`);
    }
  }
});

test("flow 468 AC8: the prompt holds the stop rules", () => {
  for (const scenario of SETUP_SCENARIOS) {
    const prompt = promptFor(scenario.id, true);
    expect(prompt).toMatch(/stop at the first failed required step/i);
    expect(prompt).toMatch(/diverg/i);
    expect(prompt).toMatch(/stop and ask/i);
  }
});

test("flow 468 AC8: the prompt holds the prohibitions", () => {
  for (const scenario of SETUP_SCENARIOS) {
    const prompt = promptFor(scenario.id, true);
    expect(prompt).toMatch(/do not delete \.metaproject/i);
    expect(prompt).toMatch(/(?:do not|never|no)[^.\n]*--force/i);
    expect(prompt).toMatch(/do not commit or push/i);
    // The substrings the pre-existing scenario prompts are tested for stay in the generated one.
    expect(prompt).toContain("Do not enrich wiki prose");
  }
});

test("flow 468 AC8: the prompt is generated from the steps, so a different root is a different prompt", () => {
  const a = promptFor("refresh", false, "/work/a");
  const b = promptFor("refresh", false, "/work/b");
  expect(a).toContain("/work/a");
  expect(a).not.toContain("/work/b");
  expect(b).toContain("/work/b");
  expect(a.replace("/work/a", "")).toBe(b.replace("/work/b", ""));
});

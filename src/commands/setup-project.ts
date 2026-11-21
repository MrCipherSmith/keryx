import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { checkGraphStaleness } from "../gdgraph/staleness";
import { GDSKILLS_PROFILES, normalizeGdskillsProfile, type GdskillsProfile } from "../gdskills/catalog";
import { keryxConfigDir } from "../lib/config-dir";
import { placePathWithinSync, resolveProjectRoot } from "../lib/contained-path";
import { writeContained } from "../lib/contained-write";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { currentWriterVersion, INSTALL_JOURNAL_RELATIVE_PATH, readInstallJournal } from "../lib/install-plan";
import { planMetaprojectIgnoreRules } from "../lib/metaproject-gitignore";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { isCompiledBinaryEntry } from "../lib/self-invocation";
import { refuseEscapingSymlink } from "../lib/symlink-safety";
import { ignoredLocalTargetPaths, previewEntrypointEdits, resolveProjectEntrypoints } from "../rules/entrypoint-writers";
import { projectDoctorChecks } from "./doctor";
import { planInitLifecycle } from "./init";
import { buildInitFlags, moduleCatalog } from "./modules";
import { inferManifestFromExistingMetaproject, planUpdateLifecycle } from "./update";

const SCHEMA_VERSION = 1;
const CLI_VERSION = currentWriterVersion();
const META = ".metaproject";
const MANIFEST = `${META}/metaproject.json`;
const JOURNAL = path.join(META, INSTALL_JOURNAL_RELATIVE_PATH);
const GRAPH_ACTIONS = ["none", "check", "rebuild", "check-and-rebuild"] as const;

const ACTIONS = {
  health: { module: "health", argv: ["health", "run"] },
  testingContext: { module: "testing", argv: ["test", "analyze"] },
  projectChecks: { module: "testing", argv: ["test", "run", "--changed"] },
  wikiCollect: { module: "gdwiki", argv: ["wiki", "collect", "--force"] },
  wikiIndex: { module: "gdwiki", argv: ["wiki", "index"] },
  wikiValidate: { module: "gdwiki", argv: ["wiki", "validate"] },
  wikiFreshness: { module: "gdwiki", argv: ["wiki", "freshness"] },
} as const;

type ActionId = keyof typeof ACTIONS;
type GraphAction = (typeof GRAPH_ACTIONS)[number];
type Request = {
  modules: Record<string, boolean>;
  gdskillsProfile: GdskillsProfile | undefined;
  gitignore: boolean;
  sharedAgents: boolean;
  maintenanceOnly: boolean;
  graph: GraphAction;
  actions: ActionId[];
};
type FindingAction = "repair" | "replan" | "update" | "check-and-rebuild";
type Finding = { id: string; severity: "info" | "warning" | "error"; message: string; action?: FindingAction };
type Manifest = {
  modules: Record<string, unknown>;
  standardVersion: string | null;
  agentEntrypoints?: unknown;
};
type StepId = "init" | "update" | "configure" | "gitignore" | "graph" | ActionId;
type Step = { id: StepId; status: "ready" | "skipped"; detail?: string; runsProjectCommands?: boolean };
type StepResult = {
  id: StepId;
  status: "completed" | "failed" | "skipped";
  detail?: string;
  exitCode?: number;
};

class SetupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): never {
  throw new SetupError("invalid-request", message);
}

function parseRequest(raw: string): Request {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidRequest("Request must be a JSON object.");
  }
  if (!jsonObject(value) || Object.keys(value).some((key) =>
    !["schemaVersion", "modules", "gdskillsProfile", "gitignore", "sharedAgents", "maintenanceOnly", "graph", "actions"].includes(key))) {
    invalidRequest("Unsupported setup request field.");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) invalidRequest("Expected schemaVersion 1.");
  const requested = value.modules === undefined ? {} : value.modules;
  if (!jsonObject(requested) || Object.keys(requested).some((key) => !moduleCatalog().some((module) => module.name === key))) {
    invalidRequest("Unknown module in request.");
  }
  const modules: Record<string, boolean> = {};
  for (const { name } of moduleCatalog()) {
    if (!Object.hasOwn(requested, name)) continue;
    const enabled = requested[name];
    if (typeof enabled !== "boolean") invalidRequest("Module selections must be booleans.");
    modules[name] = enabled;
  }
  const profile = value.gdskillsProfile;
  if (profile !== undefined && !GDSKILLS_PROFILES.some((name) => name === profile)) invalidRequest("Unknown gdskills profile.");
  const graph = GRAPH_ACTIONS.find((mode) => mode === (value.graph === undefined ? "none" : value.graph));
  if (graph === undefined) invalidRequest("Unknown graph action.");
  if (value.gitignore !== undefined && typeof value.gitignore !== "boolean") invalidRequest("gitignore must be a boolean.");
  if (value.sharedAgents !== undefined && typeof value.sharedAgents !== "boolean") invalidRequest("sharedAgents must be a boolean.");
  if (value.maintenanceOnly !== undefined && typeof value.maintenanceOnly !== "boolean") invalidRequest("maintenanceOnly must be a boolean.");
  const actions = value.actions === undefined ? [] : value.actions;
  const knownActions = Object.keys(ACTIONS) as ActionId[];
  if (!Array.isArray(actions) || actions.some((action: unknown) => !knownActions.some((id) => id === action))) {
    invalidRequest("Unknown setup action.");
  }
  return {
    modules,
    gdskillsProfile: GDSKILLS_PROFILES.find((name) => name === profile),
    gitignore: value.gitignore === true,
    sharedAgents: value.sharedAgents === true,
    maintenanceOnly: value.maintenanceOnly === true,
    graph,
    actions: knownActions.filter((id) => actions.includes(id)),
  };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function snapshot(root: string, relative: string): Promise<Buffer | null> {
  const refusal = await refuseEscapingSymlink(root, relative.split(path.sep).join("/"));
  if (refusal) throw new SetupError("unsafe-path", refusal);
  const placed = placePathWithinSync(root, relative, root);
  if (!placed.ok) throw new SetupError("unsafe-path", placed.message);
  try {
    const info = await stat(placed.path);
    if (!info.isFile()) throw new SetupError("unsafe-path", `${relative} must be a regular file.`);
    return await readFile(placed.path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function receiptPath(root: string): string {
  return path.join(keryxConfigDir(), "setup-receipts", `${digest(root)}.json`);
}

async function readReceipt(root: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(receiptPath(root), "utf8"));
    return jsonObject(value) && value.schemaVersion === SCHEMA_VERSION && value.root === root ? value : null;
  } catch {
    return null;
  }
}

function compareVersions(recorded: string | null): "unknown" | "current" | "older" | "newer" {
  if (recorded === CLI_VERSION) return "current";
  const semver = /^(\d+)\.(\d+)\.(\d+)$/;
  const from = recorded?.match(semver)?.slice(1).map(Number);
  const to = CLI_VERSION.match(semver)?.slice(1).map(Number);
  if (!from || !to) return "unknown";
  const difference = from.map((value, index) => value - (to[index] ?? 0)).find((delta) => delta !== 0);
  return difference === undefined ? "current" : difference > 0 ? "newer" : "older";
}

async function inspect(root: string, includeDoctor: boolean) {
  const findings: Finding[] = [];
  let state: "uninitialized" | "initialized" | "incomplete" = "uninitialized";
  let manifest: Manifest | null = null;
  let manifestBytes: Buffer | null = null;
  let writerVersion: string | null = null;
  let journalBytes: Buffer | null = null;
  const enclosingRoot = resolveProjectRoot(root);
  if (enclosingRoot !== root) {
    findings.push({ id: "nested-folder", severity: "error", message: "Open the enclosing project root to configure it." });
  }
  try {
    const directory = await lstat(path.join(root, META)).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (directory && !directory.isDirectory()) throw new SetupError("unsafe-path", ".metaproject must be a directory.");
    if (directory) {
      state = "incomplete";
      manifestBytes = await snapshot(root, MANIFEST);
      if (manifestBytes) {
        let value: unknown;
        try {
          value = JSON.parse(manifestBytes.toString("utf8"));
        } catch {
          throw new SetupError("invalid-manifest", "The Metaproject manifest is not valid JSON.");
        }
        if (!jsonObject(value) || !jsonObject(value.modules) ||
          Object.values(value.modules).some((module) => !jsonObject(module) || typeof module.enabled !== "boolean")) {
          throw new SetupError("invalid-manifest", "The Metaproject manifest has an invalid module configuration.");
        }
        manifest = {
          modules: { ...value.modules, gdwiki: value.modules.gdwiki ?? value.modules.wiki },
          standardVersion: typeof value.standardVersion === "string" ? value.standardVersion : null,
          agentEntrypoints: value.agentEntrypoints,
        };
        state = "initialized";
      } else {
        const inferred = await inferManifestFromExistingMetaproject(path.join(root, META));
        manifest = { modules: inferred.modules ?? {}, standardVersion: null };
        findings.push({ id: "manifest-missing", severity: "warning", message: "The .metaproject folder exists without a manifest. Module selections were inferred from the existing files.", action: "repair" });
      }
      journalBytes = await snapshot(root, JOURNAL);
      const journal = await readInstallJournal(path.join(root, META));
      writerVersion = typeof journal?.writerVersion === "string" ? journal.writerVersion : null;
      if (journalBytes && !journal) findings.push({ id: "journal-invalid", severity: "warning", message: "The install journal could not be read." });
      if (journal) {
        const interrupted = Object.values(journal.steps).filter((step) => step?.status === "begun" || step?.status === "failed");
        if (interrupted.length > 0) findings.push({ id: "interrupted-install", severity: "warning", message: `${interrupted.length} managed install steps need attention.`, action: "replan" });
      }
    }
  } catch (error) {
    const id = error instanceof SetupError ? error.code : "unreadable-metaproject";
    findings.push({ id, severity: "error", message: error instanceof SetupError ? error.message : "Metaproject files could not be read or parsed." });
    if (state !== "initialized") state = "incomplete";
  }

  const compatibility = compareVersions(writerVersion);
  if (compatibility === "newer") {
    findings.push({ id: "newer-project-writer", severity: "error", message: "Update the Keryx CLI before making changes to this project." });
  } else if (compatibility === "older") {
    findings.push({ id: "update-available", severity: "info", message: "This CLI can refresh the project’s managed files.", action: "update" });
  } else if (state === "initialized" && compatibility === "unknown") {
    findings.push({ id: "unknown-writer", severity: "info", message: "The project writer version could not be established." });
  }

  const modules = moduleCatalog().map(({ name, desc, defaultEnabled }) => {
    const config = manifest && Object.hasOwn(manifest.modules, name) ? manifest.modules[name] : undefined;
    return { name, description: desc, defaultEnabled, enabled: manifest ? jsonObject(config) && config.enabled === true : null };
  });
  const gdskills = manifest?.modules.gdskills;
  const profile = normalizeGdskillsProfile(jsonObject(gdskills) && typeof gdskills.profile === "string" ? gdskills.profile : undefined);
  const lastApply = includeDoctor ? await readReceipt(root) : null;
  if (lastApply?.status === "running" || lastApply?.status === "partial") {
    findings.push({ id: "incomplete-setup", severity: "warning", message: "The last setup did not complete. Generate a new plan to continue.", action: "replan" });
  }
  if (includeDoctor && state === "initialized" && !findings.some((finding) => finding.severity === "error")) {
    const graphEnabled = modules.some(({ name, enabled }) => name === "gdgraph" && enabled);
    const wikiEnabled = modules.some(({ name, enabled }) => name === "gdwiki" && enabled);
    for (const check of await projectDoctorChecks(root)) {
      if (check.status === "ok") continue;
      if (check.id === "graph-freshness" && !graphEnabled) continue;
      if (check.id === "wiki-freshness" && !wikiEnabled) continue;
      const action = check.id === "graph-freshness" ? "check-and-rebuild" : check.fix === "keryx update" ? "update" : undefined;
      findings.push({
        id: check.id, severity: check.status === "fail" ? "error" : "warning", message: check.detail,
        ...(action === undefined ? {} : { action }),
      });
    }
  }

  return {
    report: {
      root,
      enclosingRoot: enclosingRoot === root ? null : enclosingRoot,
      state,
      cliVersion: CLI_VERSION,
      writerVersion,
      standardVersion: manifest?.standardVersion ?? null,
      compatibility,
      modules,
      gdskillsProfile: profile,
      gdskillsProfiles: GDSKILLS_PROFILES,
      graphActions: GRAPH_ACTIONS,
      actions: Object.entries(ACTIONS).map(([id, { module }]) => ({ id, module, runsProjectCommands: id === "health" || id === "projectChecks" })),
      findings,
      lastApply,
    },
    manifest,
    inputs: { manifest: manifestBytes && digest(manifestBytes), journal: journalBytes && digest(journalBytes) },
  };
}

function gitignorePlan(before: Buffer | null, hasGit: boolean, requested: boolean) {
  if (!requested) return null;
  const current = before?.toString("utf8") ?? "";
  if (!hasGit) return { path: ".gitignore", action: "skip", detail: "Git working tree unavailable." } as const;
  if (before && !Buffer.from(current).equals(before)) {
    return { path: ".gitignore", action: "conflict", detail: "The existing file is not valid UTF-8." } as const;
  }
  if (current.replace(/\r?\n$/, "").split(/\r?\n/).at(-1) === "/.metaproject/") {
    return { path: ".gitignore", action: "unchanged" } as const;
  }
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const separator = current.length > 0 && !current.endsWith("\n") ? newline : "";
  return { path: ".gitignore", action: before === null ? "create" : "update", before: before === null ? null : current, after: `${current}${separator}/.metaproject/${newline}` } as const;
}

function availableStep(id: StepId, skippedBecause?: string): Step {
  return skippedBecause === undefined ? { id, status: "ready" } : { id, status: "skipped", detail: skippedBecause };
}

async function trackedMetaprojectPaths(root: string) {
  const proc = Bun.spawn(["git", "ls-files", "-z", "--", ".metaproject/"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new SetupError("git-inspection-failed", "Could not inspect existing tracked Metaproject paths.");
  const files = output.split("\0").filter(Boolean);
  return { count: files.length, examples: files.slice(0, 25), fingerprint: digest(output) };
}

async function plan(root: string, request: Request, commonDir: string | null) {
  const { report, manifest, inputs } = await inspect(root, false);
  const blocked = report.findings.filter((finding) => finding.severity === "error");
  const enabled = new Set(report.modules.filter(({ name, defaultEnabled, enabled }) =>
    request.modules[name] ?? enabled ?? defaultEnabled).map(({ name }) => name));
  const profile = request.gdskillsProfile ?? report.gdskillsProfile;
  const changed = report.modules.some((module) => module.enabled !== enabled.has(module.name)) || profile !== report.gdskillsProfile;
  const configure = changed || request.sharedAgents;
  const intent = manifest && !configure ? "update" : "init";
  const existing = report.state === "initialized";
  const flags = intent === "update"
    ? ["--skip-runtime", "--no-prune", "--no-tasks"]
    : [...buildInitFlags(enabled, profile), "--skip-testing-analysis",
      ...(request.sharedAgents ? ["--shared-agents"] : []),
      ...(existing ? ["--preserve-project-settings", "--refresh-services"] : [])];
  if (request.maintenanceOnly && (!existing || configure || request.gitignore)) {
    blocked.push({ id: "maintenance-requires-initialized-project", severity: "error", message: "Maintenance-only plans require an initialized project and unchanged module and file selections." });
  }
  const steps: Step[] = request.maintenanceOnly ? [] : [{ id: manifest && configure ? "configure" : intent, status: "ready" }];
  if (request.gitignore) steps.push(availableStep("gitignore", commonDir ? undefined : "Git working tree unavailable."));
  if (request.graph !== "none") {
    steps.push(availableStep("graph", enabled.has("gdgraph") ? undefined : "gdgraph is disabled."));
  }
  for (const id of request.actions) {
    const installed = enabled.has(ACTIONS[id].module);
    steps.push({ ...availableStep(id, installed ? undefined : `${ACTIONS[id].module} is disabled.`), runsProjectCommands: id === "health" || id === "projectChecks" });
  }
  if (request.maintenanceOnly && !steps.some(({ status }) => status === "ready")) {
    blocked.push({ id: "no-maintenance-selected", severity: "error", message: "Select an available maintenance action before applying." });
  }
  const enteredProject = blocked.length === 0 && !request.maintenanceOnly;
  const [beforeIgnore, exclude, settings] = await Promise.all([
    enteredProject ? snapshot(root, ".gitignore") : null,
    enteredProject && commonDir ? snapshot(commonDir, "info/exclude") : null,
    enteredProject ? Promise.all([".claude/settings.json", ".claude/settings.local.json"].map(async (filename) => {
      const value = await snapshot(root, filename);
      return value && digest(value);
    })) : null,
  ]);
  const ignoreEdit = blocked.length === 0 ? gitignorePlan(beforeIgnore, commonDir !== null, request.gitignore) : null;
  const tracked = commonDir && blocked.length === 0 && request.gitignore ? await trackedMetaprojectPaths(root) : null;
  const lifecycle = enteredProject
    ? await (intent === "init" ? planInitLifecycle(root, flags) : planUpdateLifecycle(root, flags))
    : null;
  const agentEntrypoints = manifest?.agentEntrypoints;
  const entrypoints = lifecycle ? await previewEntrypointEdits(root, agentEntrypoints, { enableTasks: enabled.has("tasks"), sharedAgents: request.sharedAgents }) : [];
  const targets = lifecycle ? await resolveProjectEntrypoints(root, agentEntrypoints, { sharedAgents: request.sharedAgents }) : null;
  const ignore = targets && commonDir ? await planMetaprojectIgnoreRules(root, { localTargets: ignoredLocalTargetPaths(targets.targets) }) : null;
  if (ignoreEdit?.action === "conflict") {
    blocked.push({ id: "gitignore-conflict", severity: "error", message: ignoreEdit.detail });
  }
  if ((ignoreEdit?.action === "create" || ignoreEdit?.action === "update") && ignore?.status === "planned" && ignore.gitignoreBlock === "moves") {
    blocked.push({ id: "gitignore-migration", severity: "error", message: "Refresh the existing managed ignore block before adding a shared ignore rule." });
  }
  const files = lifecycle?.steps.map(({ id, path: filename, outcome, reason, expectedBaseDigest, plannedDigest, recordedDigest, recordedWriterVersion, previouslyBegun }) => ({
    id, path: path.relative(root, filename), outcome, reason, expectedBaseDigest, plannedDigest, recordedDigest, recordedWriterVersion, previouslyBegun,
  })) ?? [];
  for (const file of files.filter(({ outcome }) => outcome === "conflict")) {
    blocked.push({ id: file.id, severity: "error", message: `Managed file diverged: ${file.path}.` });
  }
  for (const edit of entrypoints.filter(({ action }) => action === "conflict")) {
    blocked.push({ id: "entrypoint-conflict", severity: "error", message: `Entrypoint needs attention: ${edit.path}.` });
  }
  if (ignore?.status === "planned" && ignore.exclude.status === "refused") {
    blocked.push({ id: "git-exclude", severity: "error", message: ignore.exclude.detail });
  }
  if (ignoreEdit?.action === "unchanged" && commonDir) {
    const step = steps.find(({ id }) => id === "gitignore");
    if (step) Object.assign(step, { status: "skipped", detail: "The shared ignore rule is already present." });
  }

  const planId = digest(JSON.stringify({
    root, commonDir, CLI_VERSION, request, inputs, enabled: [...enabled], profile, intent,
    files, lifecycleFingerprint: lifecycle?.inputFingerprint, entrypoints, ignore, settings, exclude: exclude && digest(exclude), ignoreEdit, tracked: tracked?.fingerprint, gitignore: beforeIgnore && digest(beforeIgnore), blocked,
  }));
  return {
    result: {
      planId,
      root,
      cliVersion: CLI_VERSION,
      status: blocked.length === 0 ? "ready" : "blocked",
      mode: request.maintenanceOnly ? "maintenance" : report.state === "incomplete" ? "repair" : existing ? "update" : "init",
      modules: report.modules.map((module) => ({ ...module, selected: enabled.has(module.name) })),
      gdskillsProfile: profile,
      steps, blocked, files, entrypoints, ignore, gitignore: ignoreEdit,
      trackedMetaproject: tracked && { count: tracked.count, examples: tracked.examples },
      effects: { fetchRuntime: false, runCustomHooks: false, pruneWorktrees: false, reconcileManagedHooks: !request.maintenanceOnly, managedHooksPreview: request.maintenanceOnly ? "unchanged" : "unavailable" },
    },
    lifecycle: { argv: [intent, ...flags] },
    ignoreEdit,
  };
}

async function gitDirectory(root: string): Promise<string | null> {
  const directory = await resolveGitCommonDir(root);
  return directory ? await realpath(directory) : null;
}

async function runKeryx(root: string, args: readonly string[]): Promise<number> {
  const entry = process.argv[1];
  if (!entry) throw new SetupError("cli-entrypoint-missing", "Could not locate the running Keryx CLI.");
  const interpreterArgs = isCompiledBinaryEntry(entry) ? [] : [...SAFE_BUN_SPAWN_ARGS, path.resolve(entry)];
  const task = Bun.spawn([process.execPath, ...interpreterArgs, ...args], {
    cwd: root,
    env: { ...process.env, KERYX_NONINTERACTIVE: "1" },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  return await task.exited;
}

async function applyGraph(root: string, graph: GraphAction): Promise<Omit<StepResult, "id">> {
  if (graph !== "rebuild") {
    const evidence = await checkGraphStaleness(root);
    if (evidence.status === "unknown") return { status: "failed", detail: evidence.reasons.join("; ") };
    if (graph === "check" || evidence.status === "fresh") {
      return { status: "completed", detail: [evidence.status, ...evidence.reasons].join(". ") };
    }
  }
  const exitCode = await runKeryx(root, ["gdgraph", "build"]);
  return { status: exitCode === 0 ? "completed" : "failed", exitCode };
}

async function apply(root: string, request: Request, approved: string) {
  const commonDir = await gitDirectory(root);
  // A shared lock for linked worktrees accounts for Git's common hooks and info/exclude.
  const lockBase = commonDir ?? path.join(keryxConfigDir(), "setup-locks");
  const lockName = commonDir ? "keryx-setup.lock" : `${digest(root)}.lock`;
  return await withFileLock(path.join(lockBase, lockName), async () => {
    if (commonDir !== await gitDirectory(root)) throw new SetupError("stale-plan", "The Git working tree changed. Generate a new plan.");
    const prepared = await plan(root, request, commonDir);
    if (prepared.result.planId !== approved) throw new SetupError("stale-plan", "Project inputs changed. Generate a new plan.");
    if (prepared.result.blocked.length > 0) throw new SetupError("blocked-plan", "Resolve the plan’s blocked items before applying.");
    const results: StepResult[] = [];
    const saveReceipt = async (status: "running" | "partial" | "completed", active: StepId | null = null) => {
      await writeFileAtomic(receiptPath(root), JSON.stringify({
        schemaVersion: SCHEMA_VERSION, root, planId: approved, status, active, steps: results,
      }), { mode: 0o600 });
    };
    let journaled = true;
    for (const step of prepared.result.steps) {
      if (step.status === "skipped") {
        results.push({ id: step.id, status: "skipped", ...(step.detail && { detail: step.detail }) });
        continue;
      }
      if (results.some(({ status }) => status === "failed")) {
        results.push({ id: step.id, status: "skipped", detail: "A preceding step failed." });
        continue;
      }
      try {
        await saveReceipt("running", step.id);
      } catch {
        journaled = false;
        results.push({ id: step.id, status: "failed", detail: "Could not record setup progress." });
        continue;
      }
      try {
        if (step.id === "gitignore") {
          const edit = prepared.ignoreEdit;
          if (edit?.action === "create" || edit?.action === "update") {
            const actual = await snapshot(root, ".gitignore");
            if ((actual?.toString("utf8") ?? null) !== edit.before) {
              throw new SetupError("stale-plan", ".gitignore changed during setup. Generate a new plan.");
            }
            await writeContained(root, ".gitignore", edit.after, { exclusive: edit.action === "create" });
          }
          results.push({ id: step.id, status: "completed" });
        } else if (step.id === "graph") {
          results.push({ id: step.id, ...await applyGraph(root, request.graph) });
        } else {
          const command = step.id === "init" || step.id === "update" || step.id === "configure" ? prepared.lifecycle.argv : ACTIONS[step.id].argv;
          const exitCode = await runKeryx(root, command);
          results.push({ id: step.id, status: exitCode === 0 ? "completed" : "failed", exitCode });
        }
      } catch (error) {
        const detail = error instanceof SetupError ? error.message : "The operation could not be completed.";
        results.push({ id: step.id, status: "failed", detail });
      }
    }
    const failed = results.some(({ status }) => status === "failed");
    if (journaled) {
      try {
        await saveReceipt(failed ? "partial" : "completed");
      } catch {
        journaled = false;
      }
    }
    const incomplete = failed || !journaled;
    return {
      root, planId: approved, status: incomplete ? "partial" : "completed",
      steps: results, recovery: incomplete ? "replan" : null, journaled,
    } as const;
  }, { timeoutMs: 5_000 });
}

export const SETUP_JSON_USAGE = [
  "  inspect --json                               Inspect the selected project.",
  "  plan --request <JSON> --json                 Preview setup without writing.",
  "  apply --request <JSON> --plan-id <id> --json   Apply the approved preview.",
].join("\n");

export async function setupProjectCommand(operation: "inspect" | "plan" | "apply", args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(`keryx setup\n${SETUP_JSON_USAGE}`);
    return;
  }
  let output: object;
  try {
    const parsed = new Map<string, string>();
    const expected = new Set(operation === "inspect" ? [] : operation === "plan" ? ["--request"] : ["--request", "--plan-id"]);
    for (let i = 0; i < args.length; i++) {
      const option = args[i]!;
      if (parsed.has(option)) invalidRequest("Duplicate setup option.");
      if (option === "--json") {
        parsed.set(option, "");
        continue;
      }
      const value = args[++i];
      if (!expected.delete(option) || value === undefined || value.startsWith("--")) invalidRequest("Unexpected or missing setup option.");
      parsed.set(option, value);
    }
    if (expected.size > 0) invalidRequest("Required setup option is missing.");
    const root = await realpath(process.cwd());
    if (operation === "inspect") {
      output = (await inspect(root, true)).report;
    } else {
      const request = parseRequest(parsed.get("--request")!);
      if (operation === "plan") {
        output = (await plan(root, request, await gitDirectory(root))).result;
      } else {
        const planId = parsed.get("--plan-id")!;
        if (!/^[a-f0-9]{64}$/.test(planId)) invalidRequest("Expected a plan ID from setup plan.");
        const result = await apply(root, request, planId);
        if (result.status === "partial") process.exitCode = 1;
        output = result;
      }
    }
  } catch (error) {
    const busy = error instanceof Error && error.message.startsWith("Timed out waiting for lock:");
    const code = error instanceof SetupError ? error.code : busy ? "busy" : "setup-failed";
    const message = error instanceof SetupError ? error.message : busy ? "Another setup is running. Try again shortly." : "Setup could not complete.";
    output = { status: "error", error: { code, message } };
    process.exitCode = busy ? 75 : 1;
  }
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation, ...output }));
}

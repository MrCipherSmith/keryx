// `verifyAgents` — the ONE checker `keryx agents verify` runs (W2 §"CLI
// surface", AC5/AC6). It never re-derives compile/export logic (D-2): every
// export-support answer comes from `agentExportSupport` in `./export.ts`
// (T7), and every schema question comes from `validateAgentDefinition`
// (`./schema.ts`, T5). This module only assembles named PROBLEMS from those
// answers plus the tool/skill/policy/origin checks the spec assigns to
// `verify` specifically.
//
// Fail-closed rule (AC6): a `generated` definition whose W1 stack pack
// cannot be confirmed to exist is a failure, not a warning — the default
// resolver returns `false` for anything it cannot positively confirm, never
// `true` by omission.
//
// Never throws. Every entry point returns a result object; a definition that
// cannot be checked at all (e.g. `--name` naming nothing in the catalog)
// becomes a `not-found` problem row rather than an exception.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { defaultBundledRoot } from "../gdskills/bundled-eval";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { checkStablePackGate } from "../gdskills/governance/eval";
import { agentExportSupport, defaultAgentSupportLookup, type AgentSupportLookup } from "./export";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { loadAgentCatalog, type AgentCatalogError } from "./catalog";
import { generateStackAgentPair, type StackPackForAgentGeneration } from "./generate";
import { isAgentPolicyProfile } from "./policy";
import { validateAgentDefinition } from "./schema";
import { isAgentToolName, type AgentToolName } from "./tools";
import type { AgentDefinition, AgentExportRuntime, AgentSource, ExportSupportLevel, LoadedAgent } from "./types";

// R1-F7 (review 310 round 1): a W1 stack-pack id is a single safe path
// segment — lowercase, starting with a letter, hyphen-separated (matches the
// `<stack-id>` examples in
// docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md,
// e.g. `python`, `django`, `fastapi`). Validating this BEFORE any path join
// closes the traversal: a `sourceRef` of `../agents` (or any absolute path,
// `..`, or embedded separator) is rejected as `invalid-source-ref` and never
// reaches `path.join`.
const STACK_SOURCE_REF_RE = /^[a-z][a-z0-9-]*$/;

// R1-F5 (review 310 round 1): the write/shell subset of `AGENT_TOOL_VOCABULARY`
// a `read-only` definition must never name. Defined locally rather than
// imported from `./tools.ts` — that module exports only the full vocabulary
// and the per-target mapping, not a write/shell subset, and T14 is
// concurrently editing `./tools.ts` and `./policy.ts` in a parallel task on
// this same flow, so this stays a local, self-contained constant.
const WRITE_OR_SHELL_TOOLS: ReadonlySet<AgentToolName> = new Set<AgentToolName>(["apply_patch", "shell_exec"]);

export const AGENT_EXPORT_RUNTIMES: readonly AgentExportRuntime[] = [
  "claude",
  "codex",
  "kiro",
  "opencode",
  "keryx-shell",
];

export type AgentVerifyProblemReason =
  | "schema-invalid"
  | "unknown-tool"
  | "unknown-skill"
  | "unknown-policy-profile"
  | "policy-tool-conflict"
  | "origin-missing-source-ref"
  | "invalid-source-ref"
  | "stack-pack-missing"
  | "stack-pack-not-gate-cleared"
  | "generated-drift"
  | "generated-source-mismatch"
  | "baseline-in-body"
  | "no-export-support"
  | "catalog-error"
  | "not-found";

export interface AgentVerifyProblem {
  readonly reason: AgentVerifyProblemReason;
  readonly detail: string;
}

export interface AgentVerifyExportSupport {
  readonly runtime: AgentExportRuntime;
  readonly supportLevel: ExportSupportLevel;
}

export interface AgentVerifyResult {
  readonly name: string;
  /** `null` only for a `not-found` row — a name that resolved to nothing in the catalog. */
  readonly source: AgentSource | null;
  readonly problems: readonly AgentVerifyProblem[];
  /** The support level every export runtime resolves to, even when `problems` is empty. */
  readonly exportSupport: readonly AgentVerifyExportSupport[];
}

export interface VerifyAgentsOptions {
  /** Verify only this agent name. Absent from the catalog → a single `not-found` row. */
  readonly name?: string;
  /** Injectable bundled-agents directory (mirrors `LoadAgentCatalogOptions.bundledRoot`). */
  readonly bundledRoot?: string;
  /**
   * Confirms a W1 stack pack directory exists for a `generated` origin's
   * `sourceRef` (AC6). Default: `existsSync` a directory at
   * `<bundledRoot-or-default>/../stacks/<sourceRef>` — fails closed (returns
   * `false`) for anything it cannot positively confirm.
   */
  readonly stackPackExists?: (sourceRef: string) => boolean;
  /**
   * Flow 314, W4 Wave 4 (W2-AC6: "resolves to an existing, gate-cleared W1
   * stack pack; fails closed if ... retired"). Confirms a `generated`
   * origin's `sourceRef` names not merely an EXISTING pack directory
   * (`stackPackExists` above only answers existence) but one that is
   * actually gate-cleared: `stability === "stable"` (an `experimental` or
   * `deprecated` pack is never cleared) AND
   * `checkStablePackGate(packDir, "stable").status === "pass"`. Default: a
   * real (non-symlink) directory at `<bundledRoot-or-default>/../stacks/<sourceRef>`
   * whose `pack.json` parses and clears both checks — fails closed (returns
   * `{ cleared: false }`) for anything it cannot positively confirm. Kept
   * independent of the injectable `stackPackExists` above (which still only
   * answers existence, unchanged) so a caller can inject one without the
   * other.
   */
  readonly stackPackGateCleared?: (sourceRef: string) => { readonly cleared: boolean; readonly reason?: string };
  /**
   * Flow 314, W4 T10 (W2 §"Initial catalogue": "the pair is re-generated
   * (not hand-edited) if the pack changes — a hand edit to a generated
   * definition is flagged by `keryx agents verify`"). Loads the
   * `StackPackForAgentGeneration`-shaped subset of a `generated` origin's
   * `sourceRef` pack's `pack.json`, for regenerating and diffing against a
   * BUNDLED agent's on-disk content (never a `project`-source override — a
   * project definition intentionally forking a bundled one is not drift).
   * Returns `undefined` when the pack cannot be positively read/parsed with
   * a usable `agentProfile` — the drift check is then skipped for that
   * agent rather than crashing or inventing a `generated-drift` finding
   * (the pack's existence/gate status is already covered by
   * `stackPackExists`/`stackPackGateCleared` above). Default: read
   * `<bundledRoot-or-default>/../stacks/<sourceRef>/pack.json`.
   */
  readonly loadStackPackForGeneration?: (sourceRef: string) => StackPackForAgentGeneration | undefined;
  /**
   * Confirms a `skills[]` entry resolves in the skill catalogue. Default:
   * `BUNDLED_GDSKILLS` names plus every directory under
   * `<projectRoot>/.metaproject/project-skills/<module>/<name>` and
   * `<projectRoot>/.metaproject/skills/gdskills/<category>/<name>` (the same
   * two trees `agent-catalogue-xref.test.ts`'s `knownAgentNames` walks for
   * shipped skill directories), plus (R1-10) a W1 stack-pack skill scoped to
   * the checked agent's own `stacks[]`/`extends` chain — see
   * {@link SkillResolutionContext}.
   */
  readonly skillExists?: (skillId: string, context?: SkillResolutionContext) => boolean;
  /** Forwarded to `agentExportSupport` (T7's `export.ts`); default: `defaultAgentSupportLookup`. */
  readonly supportLookup?: AgentSupportLookup;
}

export interface VerifyAgentsReport {
  readonly ok: boolean;
  readonly agents: readonly AgentVerifyResult[];
  /** Catalog-load failures (unreadable file, invalid frontmatter/schema at load time, duplicate name, stem mismatch) — never silently dropped. */
  readonly catalogErrors: readonly AgentCatalogError[];
}

/**
 * Default stack-pack resolver: a real directory under
 * `<bundledRoot>/../stacks/<sourceRef>`. Fails closed.
 *
 * R1-F7: `sourceRef` shape is validated by `verifyOne` (as `invalid-source-ref`)
 * before this resolver is ever called, so by the time `sourceRef` reaches the
 * `path.join` below it is already confirmed to be a single safe id segment —
 * no `..`, no separators, no absolute path. This resolver adds a second,
 * independent layer: it `lstat`s (never follows symlinks) and refuses
 * anything that is not a real, non-symlinked directory, so a pack "id" that
 * happens to collide with a symlink planted under `stacks/` still fails
 * closed instead of resolving through it.
 */
function defaultStackPackExists(bundledAgentsRoot: string): (sourceRef: string) => boolean {
  const stacksRoot = path.join(path.dirname(bundledAgentsRoot), "stacks");
  return (sourceRef: string): boolean => {
    if (!STACK_SOURCE_REF_RE.test(sourceRef)) return false;
    const packDir = path.join(stacksRoot, sourceRef);
    // Defense in depth: even though the id pattern already rules out
    // traversal, confirm the resolved path is still contained under
    // `stacksRoot` before trusting it.
    const relative = path.relative(stacksRoot, packDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      const stats = lstatSync(packDir);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  };
}

interface StackPackJsonShape {
  readonly stability?: unknown;
}

/**
 * Shared gate-cleared check (flow 314, W4 T13a: `agents generate` must
 * refuse the same packs `agents verify` flags via `stack-pack-not-gate-cleared`,
 * so both go through this ONE function rather than each re-deriving the
 * definition of "cleared"). Takes an already-resolved, already-path-validated
 * `packDir` — path-safety (id shape, symlink/traversal checks) is the
 * caller's job (`defaultStackPackGateCleared` below, and
 * `agents-catalog.ts`'s `generate` command); this function only answers
 * whether the pack AT that directory is gate-cleared: `pack.json` parses,
 * declares `stability: "stable"`, and clears
 * `checkStablePackGate(packDir, "stable")`. Fails closed — any read/parse
 * failure, non-"stable" stability, or non-"pass" gate status returns
 * `{ cleared: false, reason }`, never `{ cleared: true }` by omission.
 */
export function checkStackPackGateCleared(packDir: string): { readonly cleared: boolean; readonly reason?: string } {
  const packJsonPath = path.join(packDir, "pack.json");
  let pack: StackPackJsonShape;
  try {
    pack = JSON.parse(readFileSync(packJsonPath, "utf8")) as StackPackJsonShape;
  } catch (error) {
    return { cleared: false, reason: `pack.json could not be read/parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (pack.stability !== "stable") {
    return { cleared: false, reason: `pack stability is "${String(pack.stability)}", not "stable"` };
  }
  const gate = checkStablePackGate(packDir, "stable");
  if (gate.status !== "pass") {
    return { cleared: false, reason: gate.reason ?? `stable-pack eval gate status is "${gate.status}"` };
  }
  return { cleared: true };
}

/**
 * Default gate-cleared resolver (flow 314, W4 Wave 4, W2-AC6): a real
 * (non-symlink) directory at `<stacksRoot>/<sourceRef>` whose `pack.json`
 * parses, declares `stability: "stable"`, and clears
 * `checkStablePackGate(packDir, "stable")`. Mirrors
 * `defaultStackPackExists`'s own path-safety checks (id pattern already
 * enforced by `verifyOne` before this is ever called, `lstat` never follows a
 * symlink, resolved path confirmed contained under `stacksRoot`) rather than
 * assuming `stackPackExists` already ran — this resolver is independently
 * injectable and must fail closed on its own. Delegates the actual
 * pack.json/gate check to the shared `checkStackPackGateCleared` above.
 */
function defaultStackPackGateCleared(
  bundledAgentsRoot: string,
): (sourceRef: string) => { readonly cleared: boolean; readonly reason?: string } {
  const stacksRoot = path.join(path.dirname(bundledAgentsRoot), "stacks");
  return (sourceRef: string): { readonly cleared: boolean; readonly reason?: string } => {
    if (!STACK_SOURCE_REF_RE.test(sourceRef)) {
      return { cleared: false, reason: `"${sourceRef}" is not a valid stack-pack id` };
    }
    const packDir = path.join(stacksRoot, sourceRef);
    const relative = path.relative(stacksRoot, packDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { cleared: false, reason: `"${sourceRef}" resolves outside the stacks root` };
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(packDir);
    } catch {
      return { cleared: false, reason: `pack directory "${sourceRef}" does not exist` };
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { cleared: false, reason: `pack directory "${sourceRef}" is not a real directory` };
    }
    return checkStackPackGateCleared(packDir);
  };
}

interface StackPackAgentProfileJsonShape {
  readonly displayName?: unknown;
  readonly auditFocus?: unknown;
  readonly buildCommands?: unknown;
  readonly fixGuardrails?: unknown;
}

interface StackPackForGenerationJsonShape {
  readonly id?: unknown;
  readonly skills?: { readonly review?: unknown; readonly "build-fix"?: unknown };
  readonly agentProfile?: StackPackAgentProfileJsonShape;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate a parsed `pack.json` document carries everything
 * `generateStackAgentPair` (T10, `./generate.ts`) needs, narrowing it to
 * {@link StackPackForAgentGeneration}. Returns `undefined` for anything
 * short of that shape — never guesses a default for a missing field, since a
 * guessed field would make the regenerated content diverge from what a real
 * `keryx agents generate` run would produce and falsely report drift.
 *
 * R1-12 (review round 1, PR #692): `pack.id` is deliberately NOT compared
 * against `sourceRef` here — a mismatch is a meaningful, reportable finding
 * (`generated-source-mismatch`, checked by `verifyOne` below) rather than a
 * reason to silently skip the drift check the way an unparseable/incomplete
 * `pack.json` does. This function only narrows shape; identity checks live
 * in the caller so they can be reported rather than swallowed.
 */
function asStackPackForAgentGeneration(raw: unknown): StackPackForAgentGeneration | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const pack = raw as StackPackForGenerationJsonShape;
  if (typeof pack.id !== "string" || pack.id.length === 0) return undefined;
  const profile = pack.agentProfile;
  if (typeof profile !== "object" || profile === null) return undefined;
  if (
    typeof profile.displayName !== "string" ||
    !isStringArray(profile.auditFocus) ||
    !isStringArray(profile.buildCommands) ||
    !isStringArray(profile.fixGuardrails)
  ) {
    return undefined;
  }
  const review = pack.skills?.review;
  const buildFix = pack.skills?.["build-fix"];
  return {
    id: pack.id,
    skills: {
      ...(isStringArray(review) ? { review } : {}),
      ...(isStringArray(buildFix) ? { "build-fix": buildFix } : {}),
    },
    agentProfile: {
      displayName: profile.displayName,
      auditFocus: profile.auditFocus,
      buildCommands: profile.buildCommands,
      fixGuardrails: profile.fixGuardrails,
    },
  };
}

/**
 * Default `loadStackPackForGeneration` resolver: a real (non-symlink)
 * directory at `<stacksRoot>/<sourceRef>` whose `pack.json` parses and
 * carries a usable `agentProfile`. Mirrors `defaultStackPackGateCleared`'s
 * own path-safety checks (id shape already enforced by `verifyOne` before
 * this is ever called). Never throws: any read/parse/shape failure yields
 * `undefined`, which `verifyOne` treats as "drift unchecked", not a crash.
 */
function defaultLoadStackPackForGeneration(
  bundledAgentsRoot: string,
): (sourceRef: string) => StackPackForAgentGeneration | undefined {
  const stacksRoot = path.join(path.dirname(bundledAgentsRoot), "stacks");
  return (sourceRef: string): StackPackForAgentGeneration | undefined => {
    if (!STACK_SOURCE_REF_RE.test(sourceRef)) return undefined;
    const packDir = path.join(stacksRoot, sourceRef);
    const relative = path.relative(stacksRoot, packDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    try {
      const stats = lstatSync(packDir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
    try {
      const raw = JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8")) as unknown;
      return asStackPackForAgentGeneration(raw);
    } catch {
      return undefined;
    }
  };
}

/** Extra context `verifyOne` gives the skill resolver so a stack-pack skill name can be scoped to the agents that may legitimately name it. */
export interface SkillResolutionContext {
  /** The checked agent's own `stacks[]` (may be empty for a stack-agnostic agent). */
  readonly stacks: readonly string[];
}

interface StackPackSkillsInfo {
  readonly skillNames: ReadonlySet<string>;
  readonly extendsId: string | undefined;
  readonly deprecated: boolean;
}

/**
 * Read `<stacksRoot>/<packId>/pack.json` + `skills/` for the subset
 * {@link defaultSkillExists} needs: which skill directories actually carry a
 * `SKILL.md` (R1-10: an empty leftover directory must not count), the pack's
 * `extends` chain (a pack may legitimately reuse a parent pack's skills —
 * e.g. `react` extends `ts-js-node`), and whether the pack is `deprecated`
 * (a deprecated pack's skills are never a valid resolution target).
 */
function readStackPackSkillsInfo(stacksRoot: string, packId: string): StackPackSkillsInfo | undefined {
  const packDir = path.join(stacksRoot, packId);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(packDir, "pack.json"), "utf8"));
  } catch {
    return undefined;
  }
  const pack = raw as { readonly extends?: unknown; readonly stability?: unknown };
  const extendsId = typeof pack.extends === "string" && pack.extends.length > 0 ? pack.extends : undefined;
  const deprecated = pack.stability === "deprecated";
  const skillNames = new Set<string>();
  const skillsDir = path.join(packDir, "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
          skillNames.add(entry.name);
        }
      }
    } catch {
      // Unreadable pack's skills directory: no skill names resolve from it.
    }
  }
  return { skillNames, extendsId, deprecated };
}

/**
 * Default skill resolver: `BUNDLED_GDSKILLS` names, plus every skill
 * directory under the project's installed `.metaproject/skills/gdskills`
 * tree and its local `.metaproject/project-skills` tree, plus (flow 314, W4
 * Wave 4; narrowed by R1-10, review round 1 PR #692) a W1 stack pack's own
 * skill — but ONLY when:
 *  - the checked agent's `stacks[]` names that pack, or a pack it (or its
 *    `extends` chain) resolves to;
 *  - that pack is not `deprecated`;
 *  - `skills/<name>/SKILL.md` actually exists (an empty leftover directory
 *    never resolves).
 * Before R1-10, every stack-pack skill directory name — from ANY pack,
 * regardless of the agent's own `stacks[]`, stability, or whether a
 * `SKILL.md` existed — was flattened into one global set, so an authored
 * agent naming an unrelated (or experimental, or deleted) pack's skill
 * silently passed. `BUNDLED_GDSKILLS`/project-skills names stay unscoped —
 * those are the general-purpose skill catalog any agent may name, not a
 * stack pack's own skills.
 */
function defaultSkillExists(
  projectRoot: string,
  bundledAgentsRoot: string,
): (skillId: string, context?: SkillResolutionContext) => boolean {
  const names = new Set(BUNDLED_GDSKILLS.map((skill) => skill.name));
  const stacksRoot = path.join(path.dirname(bundledAgentsRoot), "stacks");
  const packInfo = new Map<string, StackPackSkillsInfo>();
  if (existsSync(stacksRoot)) {
    try {
      for (const packEntry of readdirSync(stacksRoot, { withFileTypes: true })) {
        if (!packEntry.isDirectory()) continue;
        const info = readStackPackSkillsInfo(stacksRoot, packEntry.name);
        if (info !== undefined) packInfo.set(packEntry.name, info);
      }
    } catch {
      // Unreadable stacks root: fall through with just the bundled/project trees.
    }
  }
  const trees = [
    path.join(projectRoot, ".metaproject", "skills", "gdskills"),
    path.join(projectRoot, ".metaproject", "project-skills"),
  ];
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    let categories: string[];
    try {
      categories = statSync(tree).isDirectory()
        ? readdirSync(tree, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [];
    } catch {
      categories = [];
    }
    for (const category of categories) {
      const categoryDir = path.join(tree, category);
      try {
        for (const entry of readdirSync(categoryDir, { withFileTypes: true })) {
          if (entry.isDirectory()) names.add(entry.name);
        }
      } catch {
        // Unreadable category directory: skip it rather than fail the whole resolver.
      }
    }
  }

  function resolvesInStackChain(skillId: string, startPackId: string): boolean {
    let current: string | undefined = startPackId;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const info = packInfo.get(current);
      if (info === undefined) return false;
      if (!info.deprecated && info.skillNames.has(skillId)) return true;
      current = info.extendsId;
    }
    return false;
  }

  return (skillId: string, context?: SkillResolutionContext): boolean => {
    if (names.has(skillId)) return true;
    if (context === undefined) return false;
    return context.stacks.some((stackId) => resolvesInStackChain(skillId, stackId));
  };
}

function verifyOne(
  loaded: LoadedAgent,
  options: {
    readonly stackPackExists: (sourceRef: string) => boolean;
    readonly stackPackGateCleared: (sourceRef: string) => { readonly cleared: boolean; readonly reason?: string };
    readonly loadStackPackForGeneration: (sourceRef: string) => StackPackForAgentGeneration | undefined;
    readonly skillExists: (skillId: string, context?: SkillResolutionContext) => boolean;
    readonly supportLookup?: AgentSupportLookup;
  },
): AgentVerifyResult {
  const { definition } = loaded;
  const problems: AgentVerifyProblem[] = [];

  const validation = validateAgentDefinition(definition);
  if (!validation.ok) {
    for (const error of validation.errors) {
      problems.push({ reason: "schema-invalid", detail: `${error.field}: ${error.message}` });
    }
  }

  if (definition.body.includes(PROMPT_DEFENSE_BASELINE)) {
    problems.push({
      reason: "baseline-in-body",
      detail: `agent "${definition.name}"'s body repeats the prompt-defense baseline text — the compiler injects it once`,
    });
  }

  for (const tool of definition.tools) {
    if (!isAgentToolName(tool)) {
      problems.push({ reason: "unknown-tool", detail: `tools[] references unknown tool "${tool}"` });
    }
  }

  for (const skillId of definition.skills) {
    if (!options.skillExists(skillId, { stacks: definition.stacks })) {
      problems.push({ reason: "unknown-skill", detail: `skills[] references unknown skill "${skillId}"` });
    }
  }

  if (!isAgentPolicyProfile(definition.policy_profile)) {
    problems.push({
      reason: "unknown-policy-profile",
      detail: `policy_profile "${definition.policy_profile}" is not a known profile`,
    });
  } else if (definition.policy_profile === "read-only") {
    // R1-F5: a `read-only` definition must not name a write/shell tool —
    // `opencode`'s renderer already strips these via its `canWrite` gate, but
    // nothing upstream of export stopped a definition from declaring the
    // conflict in the first place. Fails here with a named reason so the
    // inconsistency is caught at the source rather than silently diverging
    // per host at export time.
    const conflicting = definition.tools.filter((tool): tool is AgentToolName =>
      WRITE_OR_SHELL_TOOLS.has(tool as AgentToolName),
    );
    if (conflicting.length > 0) {
      problems.push({
        reason: "policy-tool-conflict",
        detail: `policy_profile "read-only" conflicts with write/shell tools[] entries: ${conflicting.join(", ")}`,
      });
    }
  }

  const origin = definition.origin;
  if (origin !== undefined && origin.kind !== "authored") {
    if (!origin.sourceRef || origin.sourceRef.length === 0) {
      problems.push({
        reason: "origin-missing-source-ref",
        detail: `origin.kind "${origin.kind}" requires origin.sourceRef`,
      });
    } else if (origin.kind === "generated") {
      // R1-F7: validate the shape of `sourceRef` BEFORE it is ever resolved
      // against the filesystem (by this function's own default resolver, or
      // by an injected one) — an id-shaped-only check that runs regardless
      // of which `stackPackExists` ends up being used.
      if (!STACK_SOURCE_REF_RE.test(origin.sourceRef)) {
        problems.push({
          reason: "invalid-source-ref",
          detail: `origin.sourceRef "${origin.sourceRef}" is not a valid stack-pack id (expected ${STACK_SOURCE_REF_RE.source})`,
        });
      } else if (!options.stackPackExists(origin.sourceRef)) {
        problems.push({
          reason: "stack-pack-missing",
          detail: `origin.sourceRef "${origin.sourceRef}" does not resolve to an existing W1 stack pack`,
        });
      } else {
        // Flow 314, W4 Wave 4 (W2-AC6): existence alone is not enough — a
        // `generated` definition's pack must also be GATE-CLEARED (stable
        // stability + a passing `checkStablePackGate`). Checked only once
        // `stackPackExists` has already confirmed the pack is really there,
        // so a merely-existing but retired/experimental/failing-gate pack
        // gets its own distinct, more specific reason rather than being
        // reported as simply "missing".
        const gate = options.stackPackGateCleared(origin.sourceRef);
        if (!gate.cleared) {
          problems.push({
            reason: "stack-pack-not-gate-cleared",
            detail: `origin.sourceRef "${origin.sourceRef}" is not a gate-cleared stack pack${gate.reason !== undefined ? `: ${gate.reason}` : ""}`,
          });
        }

        // Flow 314, W4 T10 (W2 §"Initial catalogue": a hand edit to a
        // generated definition is flagged by `keryx agents verify`). Only
        // for a BUNDLED-source definition — a `project`-source override of a
        // bundled generated name is an intentional fork, not drift, and this
        // module never treats it as one. Independent of gate-cleared status
        // above: a pack that fell out of gate can still have its shipped
        // agent files checked for drift against its own current pack.json.
        if (loaded.source.kind === "bundled") {
          const sourcePack = options.loadStackPackForGeneration(origin.sourceRef);
          if (sourcePack !== undefined) {
            // R1-12: a `pack.json` whose own `id` disagrees with the
            // `sourceRef` (directory name) it was loaded from is never
            // regenerated against — that would either throw (an invalid id
            // shape now fails `generateStackAgentPair`'s own validation) or
            // silently compare against the WRONG pack's derived name/content.
            // Report it as a named, non-silent finding instead.
            if (sourcePack.id !== origin.sourceRef || !STACK_SOURCE_REF_RE.test(sourcePack.id)) {
              problems.push({
                reason: "generated-source-mismatch",
                detail:
                  `bundled agent "${definition.name}"'s origin.sourceRef "${origin.sourceRef}" does not match its ` +
                  `pack.json "id" ("${sourcePack.id}") — the pack cannot be trusted to regenerate this agent`,
              });
            } else {
              let pair: ReturnType<typeof generateStackAgentPair> | undefined;
              try {
                pair = generateStackAgentPair(sourcePack);
              } catch (cause) {
                problems.push({
                  reason: "generated-source-mismatch",
                  detail: `bundled agent "${definition.name}"'s pack.json cannot be regenerated: ${cause instanceof Error ? cause.message : String(cause)}`,
                });
              }
              if (pair !== undefined) {
                const generated = [pair.auditor, pair.fixer].filter((file): file is NonNullable<typeof file> => file !== undefined);
                const expected = generated.find((file) => file.name === definition.name);
                if (expected === undefined) {
                  const names = generated.map((file) => file.name).join("\"/\"");
                  problems.push({
                    reason: "generated-source-mismatch",
                    detail:
                      `bundled agent "${definition.name}" does not match any generated name ` +
                      `(${names.length > 0 ? `"${names}"` : "none — its pack.json no longer generates anything"}) that ` +
                      `"keryx agents generate --stack ${origin.sourceRef}" would produce from its current pack.json`,
                  });
                } else if (expected.content !== loaded.raw) {
                  problems.push({
                    reason: "generated-drift",
                    detail:
                      `bundled agent "${definition.name}" no longer matches what "keryx agents generate --stack ${origin.sourceRef}" ` +
                      `would produce from its current pack.json — regenerate rather than hand-editing it`,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const exportSupport: AgentVerifyExportSupport[] = [];
  for (const runtime of AGENT_EXPORT_RUNTIMES) {
    let supportLevel: ExportSupportLevel;
    try {
      supportLevel = agentExportSupport(runtime, options.supportLookup);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      problems.push({ reason: "no-export-support", detail: `${runtime}: ${detail}` });
      continue;
    }
    exportSupport.push({ runtime, supportLevel });
  }

  return { name: definition.name, source: loaded.source, problems, exportSupport };
}

/**
 * Verify every agent in the catalog (or just `options.name`). Named reasons
 * only — never a thrown string. `ok` is `false` when any row carries a
 * problem, any `catalogErrors` entry exists (a definition that failed to
 * load at all is also a verification failure), or `options.name` resolved
 * to nothing.
 */
export function verifyAgents(projectRoot: string, options: VerifyAgentsOptions = {}): VerifyAgentsReport {
  const catalog = loadAgentCatalog(projectRoot, options.bundledRoot === undefined ? {} : { bundledRoot: options.bundledRoot });
  const bundledAgentsRoot = options.bundledRoot ?? path.join(defaultBundledRoot(), "agents");
  const stackPackExists = options.stackPackExists ?? defaultStackPackExists(bundledAgentsRoot);
  const stackPackGateCleared = options.stackPackGateCleared ?? defaultStackPackGateCleared(bundledAgentsRoot);
  const loadStackPackForGeneration = options.loadStackPackForGeneration ?? defaultLoadStackPackForGeneration(bundledAgentsRoot);
  const skillExists = options.skillExists ?? defaultSkillExists(projectRoot, bundledAgentsRoot);
  const supportLookup = options.supportLookup ?? defaultAgentSupportLookup;

  let candidates = catalog.agents;
  if (options.name !== undefined) {
    candidates = catalog.agents.filter((loaded) => loaded.definition.name === options.name);
  }

  const agents: AgentVerifyResult[] = candidates.map((loaded) =>
    verifyOne(loaded, { stackPackExists, stackPackGateCleared, loadStackPackForGeneration, skillExists, supportLookup }),
  );

  if (options.name !== undefined && candidates.length === 0) {
    agents.push({
      name: options.name,
      source: null,
      problems: [{ reason: "not-found", detail: `no agent named "${options.name}" in the catalog` }],
      exportSupport: [],
    });
  }

  const ok =
    catalog.errors.length === 0 &&
    agents.every((agent) => agent.problems.length === 0);

  return { ok, agents, catalogErrors: catalog.errors };
}

// `AgentDefinition` is re-exported so a caller of `verifyAgents` can type a
// custom `skillExists`/`stackPackExists` closure without a second import.
export type { AgentDefinition };

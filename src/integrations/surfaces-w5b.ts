// Flow 307 (W5-b), T5: surface definitions for the harnesses W5-a left out —
// gemini-cli, kiro, github-copilot-agent (all `host-hook`, `experimental`),
// zed's `acp-permission` block surface (`policy-travels-with-agent`,
// `verified`) and instructions surface, and keryx-shell's placeholder. Kept
// out of `surfaces.ts` (per the flow's plan) so that file does not keep
// growing — every surface here follows the SAME sentinel/slot discipline
// `assertRegistryCoherent` enforces, but several use bespoke merge/strip
// (kiro, github-copilot-agent) rather than the shared nested/flat walkers,
// because their documented shapes do not match either generalised shape
// `settings-json.ts` already covers (see each surface's own comment for why).
//
// Every new adapter here is `confidence: "experimental"` with a non-empty
// `riskNotes` and `sourceDocs` drawn from the first-party URLs recorded in
// this flow's `context.md` (T1 research, 2026-09-24) plus in-repo paths,
// EXCEPT zed's `acp-permission` surface, which is `verified` — it is backed
// by code (`src/acp/permission.ts`) and a pinning test, not a doc fetch.

import path from "node:path";
import {
  MANAGED_KEY,
  arrayAt,
  isManagedBy,
  mergeIntoHookArray,
  stripFromHookArray,
  addSentinelTo,
  removeSentinelFrom,
} from "./settings-json";
import { parseCopilotToolArgsCommand, parseKiroCommand, parseRunShellCommandInput } from "./codecs";
import { CTX_HOOK_SENTINEL, ctxHookCommand, nestedCtxSurface } from "./surfaces";
import {
  installMarkdownBlock,
  probeMarkdownBlock,
  uninstallMarkdownBlock,
} from "./markdown-block";
import { pathExists } from "../lib/fs";
import { SUBSYSTEM_ACP_PERMISSION, SUBSYSTEM_INSTRUCTIONS, type SurfaceAdapter, type SurfaceFlag } from "./types";

export const LAST_VERIFIED_W5B = "2026-09-24";

// ---------------------------------------------------------------------------
// gemini-cli
// ---------------------------------------------------------------------------

const GEMINI_CLI_SOURCE_DOCS = [
  "https://geminicli.com/docs/hooks/",
  "https://geminicli.com/docs/hooks/reference/",
  "https://geminicli.com/docs/hooks/writing-hooks/",
];

export const CTX_GUARD_GEMINI_CLI: SurfaceAdapter = nestedCtxSurface({
  id: "gemini-cli",
  relativePath: ".gemini/settings.json",
  confidence: "experimental",
  key: "BeforeTool",
  matcher: "run_shell_command",
  payloadCodec: parseRunShellCommandInput,
  sourceDocs: GEMINI_CLI_SOURCE_DOCS,
  riskNotes: [
    "Gemini CLI's hooks default-enabled flag and the version it was introduced in are not confirmed in first-party docs; verify on a live install.",
  ],
});

export const INSTRUCTIONS_GEMINI_CLI: SurfaceAdapter = {
  id: "instructions",
  flag: "instructions",
  subsystem: SUBSYSTEM_INSTRUCTIONS,
  sentinel: "keryx:instructions",
  confidence: "experimental",
  riskNotes: ["Whether Gemini CLI actually reads GEMINI.md end-to-end (beyond the documented context.fileName option) is not independently confirmed here."],
  sourceDocs: ["https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md"],
  settingsFile: (root) => path.join(root, "GEMINI.md"),
  relativePath: "GEMINI.md",
  slots: [],
  customInstall: (root) => installMarkdownBlock(root, "GEMINI.md"),
  customUninstall: (root) => uninstallMarkdownBlock(root, "GEMINI.md"),
  probe: (root) => probeMarkdownBlock(root, "GEMINI.md"),
};

// ---------------------------------------------------------------------------
// kiro
// ---------------------------------------------------------------------------

const KIRO_SOURCE_DOCS = [
  "https://kiro.dev/docs/hooks/",
  "https://kiro.dev/docs/hooks/types/",
  "https://kiro.dev/docs/hooks/actions/",
  "https://kiro.dev/docs/cli/v3/hooks-migration/",
];

// Kiro's documented hook shape (`.kiro/hooks/<id>.json`) is `{version:"v1",
// hooks:[{name,trigger,matcher,action:{type,command}}]}` — entries keyed by
// `action.command`, not the `command`/`hooks[].command` shapes the shared
// `managedGroups` walker in `settings-json.ts` already covers. Rather than
// widen that walker's shape vocabulary for one harness whose exact field
// names are themselves unconfirmed (see riskNotes below), this surface writes
// its own small merge/strip/validate, reusing only the sentinel primitives
// (`MANAGED_KEY`, `isManagedBy`, `stripManagedBy`, `addSentinelTo`,
// `removeSentinelFrom`) every other surface in the registry shares.
const KIRO_HOOK_ID = "keryx-ctx-guard";
// THIRD-PARTY ONLY: neither the shell tool's name nor this matcher syntax is
// confirmed by Kiro's first-party docs (see riskNotes). A permissive
// shell-ish name list is used rather than ".*" so an install does not silently
// claim to gate every tool call when it may gate none.
const KIRO_SHELL_MATCHER = "execute_bash|shell|bash";

function kiroHookEntry(): Record<string, unknown> {
  return {
    name: KIRO_HOOK_ID,
    trigger: "PreToolUse",
    matcher: KIRO_SHELL_MATCHER,
    action: { type: "command", command: ctxHookCommand("kiro") },
    [MANAGED_KEY]: CTX_HOOK_SENTINEL,
  };
}

function isKiroManagedHook(value: unknown): boolean {
  if (!isManagedBy(CTX_HOOK_SENTINEL)(value)) return false;
  const action = (value as Record<string, unknown>).action;
  return (
    typeof action === "object" &&
    action !== null &&
    (action as Record<string, unknown>).command === ctxHookCommand("kiro")
  );
}

export const CTX_GUARD_KIRO: SurfaceAdapter = {
  id: "ctx-guard",
  flag: "block",
  subsystem: "ctx-guard",
  sentinel: CTX_HOOK_SENTINEL,
  confidence: "experimental",
  riskNotes: [
    "Kiro's hook stdin field names and its shell tool's name are third-party-reported only, not confirmed by first-party docs — the matcher above is a best guess and may gate nothing on a real install; verify before relying on it.",
  ],
  sourceDocs: KIRO_SOURCE_DOCS,
  settingsFile: (root) => path.join(root, ".kiro", "hooks", "keryx-ctx-guard.json"),
  relativePath: ".kiro/hooks/keryx-ctx-guard.json",
  slots: [
    { key: "version", type: "string", access: "owns" },
    { key: "hooks", type: "array", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
  ],
  merge: (s) => {
    s.version = "v1";
    const existing = arrayAt(s, undefined, "hooks");
    s.hooks = [...existing.filter((g) => !isManagedBy(CTX_HOOK_SENTINEL)(g)), kiroHookEntry()];
    addSentinelTo(s, CTX_HOOK_SENTINEL);
    return s;
  },
  strip: (s) => {
    const existing = arrayAt(s, undefined, "hooks");
    const remaining = existing.filter((g) => !isManagedBy(CTX_HOOK_SENTINEL)(g));
    if (remaining.length > 0) s.hooks = remaining;
    else delete s.hooks;
    removeSentinelFrom(s, CTX_HOOK_SENTINEL);
    return s;
  },
  validate: (s) => {
    const present = arrayAt(s, undefined, "hooks").some((g) => isKiroManagedHook(g));
    return present ? [] : ["kiro: missing PreToolUse ctx-guard hook"];
  },
  label: ".kiro/hooks/keryx-ctx-guard.json",
  payloadCodec: parseKiroCommand,
};

const KIRO_STEERING_FRONT_MATTER = "---\ninclusion: always\n---\n\n";

export const INSTRUCTIONS_KIRO: SurfaceAdapter = {
  id: "instructions",
  flag: "instructions",
  subsystem: SUBSYSTEM_INSTRUCTIONS,
  sentinel: "keryx:instructions",
  confidence: "experimental",
  riskNotes: [
    "Open Kiro issues report that steering file `inclusion` modes are not always honoured, even with `inclusion: always` set — verify on a live install.",
  ],
  sourceDocs: ["https://kiro.dev/docs/steering/"],
  settingsFile: (root) => path.join(root, ".kiro", "steering", "keryx.md"),
  relativePath: ".kiro/steering/keryx.md",
  slots: [],
  customInstall: (root) => installMarkdownBlock(root, ".kiro/steering/keryx.md", KIRO_STEERING_FRONT_MATTER),
  customUninstall: (root) => uninstallMarkdownBlock(root, ".kiro/steering/keryx.md", KIRO_STEERING_FRONT_MATTER),
  probe: (root) => probeMarkdownBlock(root, ".kiro/steering/keryx.md"),
};

// ---------------------------------------------------------------------------
// github-copilot-agent
// ---------------------------------------------------------------------------

const COPILOT_SOURCE_DOCS = [
  "https://docs.github.com/en/copilot/reference/hooks-reference",
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks",
  "https://docs.github.com/en/copilot/concepts/agents/hooks",
];

// Copilot's documented shape nests entries under `hooks.preToolUse[]`, each
// entry carrying `bash`/`powershell` command strings rather than a single
// `command` field — again not the shape `managedGroups` covers, so this
// surface reuses `mergeIntoHookArray`/`stripFromHookArray` (which only care
// about the `hooks[key]` array location, not the entry's own field names) for
// merge/strip, and writes its own `validate`.
const COPILOT_KEY = "preToolUse";

function copilotHookEntry(): Record<string, unknown> {
  const command = ctxHookCommand("github-copilot-agent");
  return {
    type: "command",
    bash: command,
    powershell: command,
    timeoutSec: 30,
    [MANAGED_KEY]: CTX_HOOK_SENTINEL,
  };
}

export const CTX_GUARD_GITHUB_COPILOT_AGENT: SurfaceAdapter = {
  id: "ctx-guard",
  flag: "block",
  subsystem: "ctx-guard",
  sentinel: CTX_HOOK_SENTINEL,
  confidence: "experimental",
  riskNotes: [
    "The shell tool's name Copilot's hook payload carries is not documented; this guard parses any tool call whose payload carries `toolArgs.command`, whatever `toolName` is.",
  ],
  sourceDocs: COPILOT_SOURCE_DOCS,
  settingsFile: (root) => path.join(root, ".github", "hooks", "keryx-ctx-guard.json"),
  relativePath: ".github/hooks/keryx-ctx-guard.json",
  slots: [
    { key: "version", type: "number", access: "owns" },
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) => {
    s.version = typeof s.version === "number" ? s.version : 1;
    return mergeIntoHookArray(s, COPILOT_KEY, copilotHookEntry(), CTX_HOOK_SENTINEL);
  },
  strip: (s) => stripFromHookArray(s, COPILOT_KEY, CTX_HOOK_SENTINEL),
  validate: (s) => {
    const command = ctxHookCommand("github-copilot-agent");
    const present = arrayAt(s, "hooks", COPILOT_KEY).some(
      (g) => isManagedBy(CTX_HOOK_SENTINEL)(g) && (g as Record<string, unknown>).bash === command,
    );
    return present ? [] : ["github-copilot-agent: missing preToolUse ctx-guard hook"];
  },
  label: ".github/hooks/keryx-ctx-guard.json (preToolUse)",
  groupShape: "nested",
  groupKey: COPILOT_KEY,
  groupContainer: "hooks",
  payloadCodec: parseCopilotToolArgsCommand,
};

export const INSTRUCTIONS_GITHUB_COPILOT_AGENT: SurfaceAdapter = {
  id: "instructions",
  flag: "instructions",
  subsystem: SUBSYSTEM_INSTRUCTIONS,
  sentinel: "keryx:instructions",
  confidence: "experimental",
  riskNotes: [
    "Whether the Copilot coding agent (as opposed to the Copilot CLI/IDE chat) reads .github/copilot-instructions.md the same way is not independently confirmed here.",
  ],
  sourceDocs: [
    "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide",
    "https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/",
  ],
  settingsFile: (root) => path.join(root, ".github", "copilot-instructions.md"),
  relativePath: ".github/copilot-instructions.md",
  slots: [],
  customInstall: (root) => installMarkdownBlock(root, ".github/copilot-instructions.md"),
  customUninstall: (root) => uninstallMarkdownBlock(root, ".github/copilot-instructions.md"),
  probe: (root) => probeMarkdownBlock(root, ".github/copilot-instructions.md"),
};

// ---------------------------------------------------------------------------
// zed — `acp-permission` block surface + probe-only instructions surface
// ---------------------------------------------------------------------------

/**
 * Satisfied entirely by keryx's own ACP runtime behavior — there is nothing
 * to install into a Zed-owned file. `src/acp/permission.ts`'s
 * `approvalFromPermissionResponse` denies by construction on every outcome
 * that is not an explicit `allow_once`/`allow_always` selection (`cancelled`,
 * a malformed payload, or an `optionId` keryx never offered all fall through
 * to `return false`), which IS the `block` surface's safety property when
 * keryx runs as the ACP agent inside Zed. `probe` therefore reports healthy
 * unconditionally: there is no artifact whose absence or drift could make
 * this surface unhealthy, only keryx's own code (pinned by
 * `permission.test.ts`).
 */
export const ACP_PERMISSION_ZED: SurfaceAdapter = {
  id: "acp-permission",
  flag: "block",
  subsystem: SUBSYSTEM_ACP_PERMISSION,
  sentinel: "acp-permission",
  confidence: "verified",
  sourceDocs: [
    "src/acp/permission.ts",
    "src/acp/permission.test.ts",
    "https://zed.dev/docs/ai/external-agents",
  ],
  slots: [],
  probe: async () => [],
};

/**
 * Probe-only: Zed uses the FIRST matching rules file among `.rules`,
 * `.cursorrules`, `.windsurfrules`, `.clinerules`,
 * `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`,
 * `GEMINI.md`, ... — an earlier file in that list shadows AGENTS.md even when
 * AGENTS.md itself is present and well-formed. There is nothing for Keryx to
 * install here beyond what `keryx init`/`keryx update` already write
 * (`src/rules/agent-entrypoints.ts`), so `customInstall` never writes
 * anything — it reports whether AGENTS.md already carries Keryx's
 * `<!-- keryx:index -->` block, and `customUninstall` never deletes AGENTS.md.
 */
const ZED_SHADOWING_RULES_FILES = [
  ".rules",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".github/copilot-instructions.md",
  "AGENT.md",
];

async function agentsMdHasKeryxBlock(root: string): Promise<boolean> {
  const file = path.join(root, "AGENTS.md");
  if (!(await pathExists(file))) return false;
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(file, "utf8");
  return content.includes("<!-- keryx:index -->");
}

export const INSTRUCTIONS_ZED: SurfaceAdapter = {
  id: "instructions",
  flag: "instructions",
  subsystem: SUBSYSTEM_INSTRUCTIONS,
  sentinel: "keryx:instructions",
  confidence: "experimental",
  riskNotes: [
    `Zed uses the first matching rules file among ${ZED_SHADOWING_RULES_FILES.join(", ")}, AGENT.md, AGENTS.md, CLAUDE.md, GEMINI.md, ... — an earlier file in that list shadows AGENTS.md even when AGENTS.md itself carries Keryx's block.`,
  ],
  sourceDocs: ["https://github.com/zed-industries/zed/blob/main/docs/src/ai/rules.md"],
  settingsFile: (root) => path.join(root, "AGENTS.md"),
  relativePath: "AGENTS.md",
  slots: [],
  customInstall: async (root) =>
    (await agentsMdHasKeryxBlock(root))
      ? []
      : ["zed: AGENTS.md is missing Keryx's block — run `keryx update` (AGENTS.md is managed by keryx init/update, not this installer)"],
  customUninstall: async () => false,
  probe: async (root) =>
    (await agentsMdHasKeryxBlock(root)) ? [] : ["zed: AGENTS.md is missing or missing Keryx's block — run `keryx update`"],
};

// ---------------------------------------------------------------------------
// keryx-shell — W6 placeholder adapter (no surfaces yet)
// ---------------------------------------------------------------------------

export const KERYX_SHELL_UNSUPPORTED_REASON =
  "Registered by W6's keryx shell hook runtime; not installed by keryx integrations yet.";

const ALL_12_SURFACE_FLAGS: readonly SurfaceFlag[] = [
  "block",
  "prompt-gate",
  "pre-tool-context",
  "inject-context",
  "observe",
  "post-tool",
  "session-start",
  "stop",
  "skills",
  "agents",
  "instructions",
  "mcp",
];

export const KERYX_SHELL_UNSUPPORTED: Partial<Record<SurfaceFlag, string>> = Object.fromEntries(
  ALL_12_SURFACE_FLAGS.map((flag) => [flag, KERYX_SHELL_UNSUPPORTED_REASON]),
) as Partial<Record<SurfaceFlag, string>>;

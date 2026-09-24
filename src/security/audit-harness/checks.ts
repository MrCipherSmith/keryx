// Flow 308 (W8 Design part A, Lane A) — the audit-harness check catalog.
// One exported pure function per check id, independently testable. Every
// function takes already-read content (never touches the filesystem itself)
// and returns `RawFinding[]` — no id, no suppression: `index.ts` assigns
// those once, after every check has run, against the baseline.

import { detectInjection } from "../detect/injection";
import { detectSecrets } from "../detect/secrets";
import { scanMcpManifest } from "../detect/mcp";
import { touchesAgentCredentials } from "../../lib/command-risk";
import { redactSensitiveText } from "../redact";
import { agentSentinelFormatOf, structuralSentinelModelTier, type AgentSentinelFormat } from "../../agents/sentinel";
import type { AuditSeverity, FindingLocation, InternalProposal, RawFinding, SurfaceId } from "./types";

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

// --- secret-in-instructions / skill-script-secret --------------------------

export function checkSecretsInText(
  surface: SurfaceId,
  check: "secret-in-instructions" | "skill-script-secret",
  relativePath: string,
  content: string,
  severity: AuditSeverity,
): RawFinding[] {
  const matches = detectSecrets(content);
  return matches.map((match) => ({
    surface,
    check,
    severity,
    confidence: match.confidence,
    path: relativePath,
    location: { line: lineOfOffset(content, match.start) },
    message: `${relativePath} contains a value matching a secret pattern (${match.policyId}).`,
    evidence: { category: match.category, policyId: match.policyId, matchedToken: match.policyId },
  }));
}

// --- prompt-injection-in-instructions / skill-script-injection -------------

export function checkInjectionInText(
  surface: SurfaceId,
  check: "prompt-injection-in-instructions" | "skill-script-injection",
  relativePath: string,
  content: string,
  severity: AuditSeverity,
): RawFinding[] {
  const matches = detectInjection(content);
  return matches.map((match) => ({
    surface,
    check,
    severity,
    confidence: match.confidence,
    path: relativePath,
    location: { line: lineOfOffset(content, match.start) },
    message: `${relativePath} contains a phrase matching a prompt-injection pattern (${match.policyId}).`,
    evidence: { category: match.category, policyId: match.policyId, matchedToken: match.policyId },
  }));
}

// --- auto-run-directive -----------------------------------------------------

const AUTO_RUN_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "audit.auto-run.always-run-without-asking", regex: /\balways\s+run\b[^.\n]{0,40}\bwithout\s+asking\b/i },
  { id: "audit.auto-run.automatically-execute", regex: /\bautomatically\s+execute\b/i },
  { id: "audit.auto-run.no-confirmation", regex: /\bdo\s+not\s+ask\s+for\s+confirmation\b/i },
  { id: "audit.auto-run.never-ask-permission", regex: /\bnever\s+ask\s+permission\b/i },
  { id: "audit.auto-run.run-immediately", regex: /\brun\s+the\s+following\s+immediately\b/i },
];

export function checkAutoRunDirective(
  surface: SurfaceId,
  relativePath: string,
  content: string,
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const pattern of AUTO_RUN_PATTERNS) {
    const match = pattern.regex.exec(content);
    if (match) {
      findings.push({
        surface,
        check: "auto-run-directive",
        severity: "high",
        confidence: 0.7,
        path: relativePath,
        location: { line: lineOfOffset(content, match.index) },
        message: `${relativePath} directs an agent to run commands without confirmation (${pattern.id}).`,
        evidence: { category: "prompt-injection", policyId: pattern.id, matchedToken: pattern.id },
      });
    }
  }
  return findings;
}

// --- settings-surface helpers ------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const WILDCARD_ALLOW_PATTERNS = new Set(["*", "Bash(*)", "Bash", "Bash(:*)"]);

export function checkOverPermissiveAllowlist(relativePath: string, settings: unknown): RawFinding[] {
  const permissions = asRecord(asRecord(settings)?.permissions);
  const allow = asStringArray(permissions?.allow);
  const findings: RawFinding[] = [];
  allow.forEach((entry, index) => {
    if (WILDCARD_ALLOW_PATTERNS.has(entry)) {
      const pointer = `/permissions/allow/${index}`;
      const internalProposal: InternalProposal = {
        proposal: {
          id: `remove-allow-${index}-${entry}`,
          rationale: `Remove the unscoped allowlist entry "${entry}" and replace it with a narrowed pattern.`,
          patch: `- ${JSON.stringify(entry)}\n+ (removed; add a narrowed Bash(<cmd>:*) pattern instead)`,
        },
        edit: { kind: "json-remove", path: relativePath, pointer },
      };
      findings.push({
        surface: "settings",
        check: "over-permissive-allowlist",
        severity: "medium",
        confidence: 0.9,
        path: relativePath,
        location: { pointer },
        message: `${relativePath} allows unscoped command execution ("${entry}") with no path/argument restriction.`,
        evidence: { category: "artifact-safety", matchedToken: `entry:${index}` },
        internalProposal,
      });
    }
  });
  return findings;
}

export function checkMissingDenyList(relativePath: string, settings: unknown): RawFinding[] {
  const permissions = asRecord(asRecord(settings)?.permissions);
  const allow = asStringArray(permissions?.allow);
  const deny = asStringArray(permissions?.deny);
  if (allow.length === 0) {
    return [];
  }
  const coversCredentials = deny.some((pattern) => touchesAgentCredentials(pattern));
  if (coversCredentials && deny.length > 0) {
    return [];
  }
  const pointer = "/permissions/deny";
  const internalProposal: InternalProposal = {
    proposal: {
      id: `add-deny-list-${relativePath}`,
      rationale: "Add a deny list covering credential and destructive command families.",
      patch: `+ "deny": ["Bash(rm -rf:*)", "Read(**/.env)", "Read(**/permissions.json)", "Read(**/auth.json)"]`,
    },
    edit: {
      kind: "json-set",
      path: relativePath,
      pointer,
      value: ["Bash(rm -rf:*)", "Read(**/.env)", "Read(**/permissions.json)", "Read(**/auth.json)"],
    },
  };
  return [
    {
      surface: "settings",
      check: "missing-deny-list",
      severity: "medium",
      confidence: 0.8,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} has an allow list but no deny entries covering credential/destructive command families.`,
      evidence: { category: "artifact-safety", matchedToken: "permissions.deny" },
      internalProposal,
    },
  ];
}

const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--dangerously-bypass-approvals-and-sandbox",
];

function collectStrings(value: unknown, into: Array<{ text: string; pointer: string }>, pointer: string): void {
  if (typeof value === "string") {
    into.push({ text: value, pointer });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, into, `${pointer}/${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as JsonRecord)) {
      collectStrings(nested, into, `${pointer}/${key}`);
    }
  }
}

export function checkBypassFlagPresent(relativePath: string, settings: unknown): RawFinding[] {
  const findings: RawFinding[] = [];
  const root = asRecord(settings);
  const permissions = asRecord(root?.permissions);
  const defaultMode = root?.defaultMode ?? permissions?.defaultMode;
  if (defaultMode === "bypassPermissions") {
    const pointer = permissions?.defaultMode === "bypassPermissions" ? "/permissions/defaultMode" : "/defaultMode";
    findings.push({
      surface: "settings",
      check: "bypass-flag-present",
      severity: "critical",
      confidence: 0.95,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} sets defaultMode to "bypassPermissions", disabling the approval gate.`,
      evidence: { category: "artifact-safety", matchedToken: "defaultMode:bypassPermissions" },
      internalProposal: {
        proposal: {
          id: `reset-default-mode-${relativePath}`,
          rationale: 'Set defaultMode back to "default" so the approval gate applies.',
          patch: '- "defaultMode": "bypassPermissions"\n+ "defaultMode": "default"',
        },
        edit: { kind: "json-set", path: relativePath, pointer, value: "default" },
      },
    });
  }
  const strings: Array<{ text: string; pointer: string }> = [];
  collectStrings(settings, strings, "");
  for (const { text, pointer } of strings) {
    for (const flag of BYPASS_FLAGS) {
      if (text.includes(flag)) {
        findings.push({
          surface: "settings",
          check: "bypass-flag-present",
          severity: "critical",
          confidence: 0.95,
          path: relativePath,
          location: { pointer: pointer || "/" },
          message: `${relativePath} records a permission-bypass flag (${flag}).`,
          evidence: { category: "artifact-safety", matchedToken: `flag:${flag}` },
        });
      }
    }
  }
  return findings;
}

// --- unpinned-mcp-launcher ---------------------------------------------------

/**
 * Whether an npm-style package spec (`pkg`, `pkg@1.2.3`, `@scope/pkg`,
 * `@scope/pkg@1.2.3`, `pkg@latest`) is pinned to a real version. A scoped
 * package with no SECOND `@` is unpinned; `@latest` never counts as a pin.
 */
export function isPinnedPackageSpec(spec: string): boolean {
  if (spec.length === 0) return false;
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    if (secondAt === -1) return false;
    const version = spec.slice(secondAt + 1);
    return version.length > 0 && version !== "latest";
  }
  const at = spec.indexOf("@");
  if (at === -1) return false;
  const version = spec.slice(at + 1);
  return version.length > 0 && version !== "latest";
}

function packageArgFromLauncher(command: string, argv: string[]): { launcher: boolean; spec: string | undefined } {
  const base = command.split("/").pop() ?? command;
  const isPnpmDlx = base === "pnpm" && argv[0] === "dlx";
  const isDirectLauncher = base === "npx" || base === "uvx" || base === "bunx";
  if (!isDirectLauncher && !isPnpmDlx) {
    return { launcher: false, spec: undefined };
  }
  const rest = isPnpmDlx ? argv.slice(1) : argv;
  const spec = rest.find((arg) => arg !== "-y" && arg !== "--yes" && !arg.startsWith("-"));
  return { launcher: true, spec };
}

export function checkUnpinnedMcpLauncher(
  relativePath: string,
  serverName: string,
  command: string,
  argv: string[],
  location: FindingLocation,
): RawFinding[] {
  const { launcher, spec } = packageArgFromLauncher(command, argv);
  if (!launcher || spec === undefined) {
    return [];
  }
  if (isPinnedPackageSpec(spec)) {
    return [];
  }
  return [
    {
      surface: "mcp-configs",
      check: "unpinned-mcp-launcher",
      severity: "high",
      confidence: 0.85,
      path: relativePath,
      location,
      message: `MCP server "${serverName}" launches an unpinned package via ${command} (no @version pin).`,
      evidence: { category: "artifact-safety", matchedToken: `server:${serverName}` },
      internalProposal: {
        proposal: {
          id: `pin-mcp-launcher-${serverName}`,
          rationale: "Pin the launched package to an explicit version.",
          patch: `- "${spec}"\n+ "${spec}@<version>"`,
        },
        edit: { kind: "manual" },
      },
    },
  ];
}

// --- mcp-tool-poisoning / mcp-rug-pull --------------------------------------

export function checkMcpManifest(
  relativePath: string,
  manifest: unknown,
  baseline: Record<string, string> | undefined,
): RawFinding[] {
  const matches = scanMcpManifest(manifest, { baseline, source: relativePath });
  return matches.map((match) => {
    const isRugPull = match.policyId.startsWith("mcp.rug-pull");
    return {
      surface: "mcp-configs",
      check: isRugPull ? "mcp-rug-pull" : "mcp-tool-poisoning",
      severity: match.severity as AuditSeverity,
      confidence: match.confidence,
      path: relativePath,
      message: match.remediation ?? `MCP manifest ${relativePath} matched ${match.policyId}.`,
      evidence: { category: match.category, policyId: match.policyId, matchedToken: match.value },
    };
  });
}

// --- hooks -------------------------------------------------------------------

const TOOL_INPUT_VAR = "(?:TOOL_INPUT|CLAUDE_TOOL_INPUT|tool_input|ARGUMENTS|1)";
const INTERP_VAR_RE = new RegExp(`\\$\\{?\\s*${TOOL_INPUT_VAR}\\s*\\}?`);
const INSIDE_SUBSHELL_RE = new RegExp(`\\$\\([^)]*\\$${TOOL_INPUT_VAR}\\b[^)]*\\)`);
const INSIDE_BACKTICK_RE = new RegExp(`\`[^\`]*\\$${TOOL_INPUT_VAR}\\b[^\`]*\``);
const INSIDE_DQUOTE_RE = new RegExp(`"[^"]*\\$\\{?\\s*${TOOL_INPUT_VAR}\\s*\\}?[^"]*"`);

export function checkHookCommandInjection(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  if (!INTERP_VAR_RE.test(hookCommand)) return [];
  const interpolated =
    INSIDE_SUBSHELL_RE.test(hookCommand) ||
    INSIDE_BACKTICK_RE.test(hookCommand) ||
    INSIDE_DQUOTE_RE.test(hookCommand) ||
    hookCommand.includes("$(") ||
    hookCommand.includes("`");
  if (!interpolated) return [];
  return [
    {
      surface: "hooks",
      check: "hook-command-injection",
      severity: "critical",
      confidence: 0.8,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} shell-interpolates a tool-input-derived value into a hook command instead of passing it as an argv element.`,
      evidence: { category: "prompt-injection", matchedToken: "hook-command" },
    },
  ];
}

const NETWORK_CLIENTS = ["curl", "wget", "nc"];

export function checkHookExfiltrationShape(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  const usesClient = NETWORK_CLIENTS.some((client) => new RegExp(`\\b${client}\\b`).test(hookCommand));
  if (!usesClient) return [];
  const fedFromStdin =
    /\|\s*(curl|wget|nc)\b/.test(hookCommand) ||
    /-d\s+@-/.test(hookCommand) ||
    /--data-binary\s+@-/.test(hookCommand);
  if (!fedFromStdin) return [];
  return [
    {
      surface: "hooks",
      check: "hook-exfiltration-shape",
      severity: "high",
      confidence: 0.75,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} pipes tool output/stdin into a network client, an exfiltration shape.`,
      evidence: { category: "egress", matchedToken: "hook-command" },
    },
  ];
}

// I2 (review round 3, investigated): only the SEPARATOR set was widened here
// (adding `||`, alongside the already-handled `;`/`&&`) — the anchor to the
// END of the string stays. A genuinely mid-command `exit 0` with more
// command chained after it (`echo hi && exit 0 && continue-cmd`) is NOT
// stripped here, on purpose, per F20's existing rationale below: removing it
// would not just unsuppress a failing gate, it would also change the
// command's CONTROL FLOW by resurrecting code that `exit 0` currently makes
// unreachable (`continue-cmd` never runs today; strip the `exit 0` and it
// would). That is not a "simple, safe regex change" — a blind global strip
// was tried and reverted here after `F20`'s own test (mid-command exit 0
// must stay a no-op) caught exactly this. `||` is safe to add to the
// TRAILING case because the reasoning is identical to `;`/`&&` there:
// nothing follows a trailing `exit 0` for control flow to change.
const TRAILING_EXIT0_RE = /\s*(?:;|&&|\|\|)\s*exit\s+0\s*$/;

/**
 * N4: strip EVERY `|| true` and `2>/dev/null` occurrence (not just the
 * first), plus a trailing `; exit 0` / `&& exit 0` / `|| exit 0` (I2: now
 * including `||`) (repeated, if the command chains more than one), then
 * trim. Pure string transform — used to build the `json-set` edit's
 * replacement VALUE directly (no text search against the raw file bytes), so
 * a command containing JSON-escaped quotes is unaffected: the value is
 * assigned into the already-parsed object graph and re-serialized, never
 * spliced into the file's text.
 */
function stripHookSuppression(command: string): string {
  let next = command.replace(/\s*\|\|\s*true\b/g, "").replace(/\s*2>\/dev\/null/g, "");
  let previous: string;
  do {
    previous = next;
    next = next.replace(TRAILING_EXIT0_RE, "");
  } while (next !== previous);
  return next.trim();
}

export function checkHookSilentSuppression(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  const suppressed =
    /\|\|\s*true\b/.test(hookCommand) ||
    /2>\/dev\/null/.test(hookCommand) ||
    /;\s*exit\s+0\b/.test(hookCommand) ||
    /&&\s*exit\s+0\b/.test(hookCommand) ||
    /\|\|\s*exit\s+0\b/.test(hookCommand);
  if (!suppressed) return [];
  const rewritten = stripHookSuppression(hookCommand);
  // N4: `checkHookSilentSuppression` is only ever called (from `index.ts`)
  // against a `command` string already extracted from a PARSED JSON settings
  // file — the previous `text-replace` edit re-searched the raw file TEXT for
  // `hookCommand` verbatim, which breaks the moment the command contains a
  // character JSON escapes on disk (a `"` becomes `\"`, for instance) and,
  // being a single `String#replace`, only ever removed the FIRST `|| true`.
  // A `json-set` edit at the command's own JSON pointer sidesteps both: it
  // mutates the parsed object graph directly (no text matching at all) and
  // writes the fully-stripped command in one shot. Kept conditional on the
  // path actually being JSON so a hypothetical non-JSON caller still gets a
  // text edit — `applyTextEdit` already refuses an edit whose `from` is not
  // exactly one match in the file (see F2), so that path stays safe too.
  const isJsonFile = relativePath.toLowerCase().endsWith(".json");
  return [
    {
      surface: "hooks",
      check: "hook-silent-suppression",
      severity: "high",
      confidence: 0.8,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} silently suppresses a failing gate hook's exit status.`,
      evidence: { category: "artifact-safety", matchedToken: "hook-command" },
      internalProposal: {
        proposal: {
          id: `remove-suppression-${pointer}`,
          rationale: "Remove the suppression so a failing hook actually reports failure.",
          // F4: the raw hook command can embed a secret (a token baked into a
          // curl/wget flag, for instance) — this `patch` is advisory display
          // text (never what the edit below actually writes), so it goes
          // through the same redaction floor used to sanitize tool output
          // before it reaches a report/log.
          patch: redactSensitiveText(`- ${hookCommand}\n+ ${rewritten}`),
        },
        edit: isJsonFile
          ? { kind: "json-set", path: relativePath, pointer, value: rewritten }
          : { kind: "text-replace", path: relativePath, from: hookCommand, to: rewritten },
      },
    },
  ];
}

const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/**
 * The same shell-suppression shapes `checkHookSilentSuppression` looks for
 * in a JSON hook `command` string — a non-JSON hook artifact (a generated
 * script/plugin file, e.g. OpenCode's bridge plugin) can embed the exact same
 * shell fragment as a string literal it shells out with, so the same three
 * patterns apply here too, not just the JS-specific empty-catch shape below.
 */
const SCRIPT_SHELL_SUPPRESSION_RE = /\|\|\s*true\b|2>\/dev\/null|;\s*exit\s+0\b/;

export function checkHookSilentSuppressionInScript(relativePath: string, content: string): RawFinding[] {
  const emptyCatch = EMPTY_CATCH_RE.exec(content);
  const shellSuppression = SCRIPT_SHELL_SUPPRESSION_RE.exec(content);
  const match =
    emptyCatch && shellSuppression
      ? emptyCatch.index <= shellSuppression.index
        ? emptyCatch
        : shellSuppression
      : (emptyCatch ?? shellSuppression);
  if (!match) return [];
  const matchedToken = match === emptyCatch ? "empty-catch" : "shell-suppression";
  const message =
    match === emptyCatch
      ? `${relativePath} has an empty catch block that silently swallows a hook failure.`
      : `${relativePath} silently suppresses a failing hook's exit status.`;
  return [
    {
      surface: "hooks",
      check: "hook-silent-suppression",
      severity: "high",
      confidence: 0.7,
      path: relativePath,
      location: { line: lineOfOffset(content, match.index) },
      message,
      evidence: { category: "artifact-safety", matchedToken },
    },
  ];
}

// --- agent-definitions -------------------------------------------------------
//
// Flow 310 (W2) T13: format-aware. `src/agents/compile.ts` writes three
// non-markdown shapes (`.codex/agents/*.toml`, `.kiro/agents/*.json`) plus
// two markdown shapes (`.claude/agents/*.md`, `.opencode/agents/*.md`) —
// only claude's frontmatter carries a first-party `tools`/`model` field of
// the kind the original markdown-only checks below looked for. Every other
// format's own allowlist/tier signal is checked in its own native shape
// (never re-derived by re-parsing a markdown-shaped check against
// non-markdown content); the check ids and the plain-markdown behavior below
// are UNCHANGED from before this task.

function parseFrontmatter(content: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      fields[kv[1]!.toLowerCase()] = (kv[2] ?? "").trim();
    }
  }
  return fields;
}

/** R2-F6: the frontmatter BLOCK's own raw YAML text (delimiters excluded) — for parsing with `Bun.YAML`, never the whole file (the body may itself contain `---`-shaped text). `undefined` when there is no well-formed block at all. */
function frontmatterBlockText(content: string): string | undefined {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
}

/** Whether a TOML top-level `key = ...` assignment appears anywhere in `content` — a dependency-free FALLBACK for when `Bun.TOML.parse` cannot make sense of `content` at all, sufficient for the single-line keys (`sandbox_mode`, `model`) codex's renderer ever emits. Prefer `tomlHasTopLevelKey` (real TOML parse), which this backs up. */
function tomlHasKey(content: string, key: string): boolean {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(content);
}

/**
 * R2-F6 (residual): the plain `tomlHasKey` regex scans the WHOLE file, so a
 * `model = ...`-shaped line embedded inside `developer_instructions`'s
 * multi-line body (prose, not real TOML structure) can be mistaken for a
 * genuine top-level key. Parse with `Bun.TOML.parse` (already used
 * elsewhere in this codebase for the same reason — `compile.format-
 * safety.test.ts`) and check the real, structured document; fall back to the
 * regex heuristic only when the content does not parse as TOML at all (a
 * hand-edited/malformed file this audit still wants to say SOMETHING about).
 */
function tomlHasTopLevelKey(content: string, key: string): boolean {
  try {
    const doc = Bun.TOML.parse(content) as Record<string, unknown>;
    if (doc && typeof doc === "object" && key in doc) return true;
    return false;
  } catch {
    return tomlHasKey(content, key);
  }
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `model_tier=<tier>` inside the keryx-managed sentinel — the one tier
 * signal available on a host format with no first-party `model`/
 * `model_tier` field of its own (codex/kiro omit `model` entirely;
 * opencode's documented frontmatter has no tier field). Only ever a
 * FALLBACK: a format's own explicit field is checked first, so this never
 * masks a hand-authored file that carries neither the field nor the
 * sentinel.
 *
 * R2-F6: anchored to `../../agents/sentinel`'s STRUCTURAL candidate position
 * (the line right after frontmatter close, TOML's first line, or — for kiro
 * — only the FIRST LINE of the parsed `prompt` field), never a whole-file or
 * whole-line-of-the-one-physical-JSON-line scan. Before this, a kiro file's
 * `prompt` value is ONE physical text line containing the entire header too
 * (JSON encodes real newlines as `\n`), so prose anywhere in that header
 * could suppress the finding; now only the sentinel's own structural line is
 * ever tested.
 */
function hasSentinelModelTier(content: string, format: AgentSentinelFormat): boolean {
  return structuralSentinelModelTier(content, format) !== undefined;
}

/**
 * R2-F3: whether claude frontmatter's `tools` value is a genuine, non-empty
 * allowlist. Tries `Bun.YAML.parse` on the frontmatter BLOCK first (real
 * type information — YAML null spellings all parse to `null`, distinct from
 * an empty string or an empty sequence), and only falls back to a scalar
 * text check on `fields.tools` (from the hand-rolled `parseFrontmatter`
 * above) when that block does not parse as YAML at all. `undefined`
 * `fields`/absent `tools` key both mean "no allowlist declared" — `false`.
 */
function claudeToolsIsAllowlist(content: string, fields: Record<string, string> | undefined): boolean {
  const block = frontmatterBlockText(content);
  if (block !== undefined) {
    try {
      const parsed = Bun.YAML.parse(block) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "tools" in (parsed as Record<string, unknown>)) {
        const toolsValue = (parsed as Record<string, unknown>).tools;
        if (toolsValue === null || toolsValue === undefined) return false;
        if (typeof toolsValue === "string" && toolsValue.trim().length === 0) return false;
        if (Array.isArray(toolsValue) && toolsValue.length === 0) return false;
        return true;
      }
      // Block parsed but carries no `tools` key at all — no allowlist.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return false;
    } catch {
      // Fall through to the scalar-text fallback below.
    }
  }
  const toolsValue = fields?.tools;
  if (toolsValue === undefined) return false;
  const trimmed = toolsValue.trim();
  const NULL_LIKE = new Set(["null", "Null", "NULL", "~", "[]"]);
  const isNullLike = trimmed.length === 0 || trimmed === '""' || trimmed === "''" || NULL_LIKE.has(trimmed);
  return !isNullLike;
}

export function checkAgentUnrestrictedTools(relativePath: string, content: string): RawFinding[] {
  const format = agentSentinelFormatOf(relativePath);
  let hasAllowlist: boolean;
  if (format === "toml") {
    // codex governs access entirely via `sandbox_mode` (read-only |
    // workspace-write) — it has no per-tool allowlist at all, so the
    // presence of that key IS the closest analog to a restriction here
    // (`compile.ts#renderCodexExport`'s own documented rationale).
    hasAllowlist = tomlHasTopLevelKey(content, "sandbox_mode");
  } else if (format === "kiro-json") {
    // kiro's `tools` is a JSON array of coarse tags/builtin names
    // (`compile.ts#renderKiroExport`).
    const doc = parseJsonObject(content);
    hasAllowlist = Array.isArray(doc?.tools);
  } else {
    // md: claude's `tools` frontmatter key, or opencode's `permission` block
    // (frontmatter `permission:` parses as a present-but-empty-value key
    // above, which is enough to detect the block exists).
    //
    // R1-F12/R2-F3: a PRESENT `tools` key is not by itself a restriction.
    // Claude Code treats an empty/null `tools` (omitted value, `""`, `''`,
    // or any YAML null spelling — `null`/`Null`/`NULL`/`~` — as well as an
    // explicit `[]`) as "no allowlist declared" and grants the subagent
    // every tool — the least-restricted outcome, not a restricted one — so
    // every one of those shapes must still count as
    // agent-unrestricted-tools rather than passing because the key exists.
    // `permission:` has no such empty-means-unrestricted footgun documented
    // for it, so its mere presence still counts as an allowlist.
    //
    // Parsed with `Bun.YAML` first (real type information: null vs "" vs []
    // vs a non-empty scalar/sequence, none of which a hand-rolled string
    // check can tell apart reliably) and falls back to a precise scalar
    // check only when the frontmatter block does not parse as YAML at all.
    const fields = parseFrontmatter(content);
    const hasPermissionBlock = !!fields && "permission" in fields;
    const toolsAllowlistResult = claudeToolsIsAllowlist(content, fields);
    hasAllowlist = toolsAllowlistResult || hasPermissionBlock;
  }
  if (hasAllowlist) return [];
  return [
    {
      surface: "agent-definitions",
      check: "agent-unrestricted-tools",
      severity: "medium",
      confidence: 0.9,
      path: relativePath,
      message: `${relativePath} has no \`tools\` allowlist in its frontmatter.`,
      evidence: { category: "artifact-safety", matchedToken: "frontmatter:tools" },
    },
  ];
}

export function checkAgentMissingModelTier(relativePath: string, content: string): RawFinding[] {
  const format = agentSentinelFormatOf(relativePath);
  let hasTier: boolean;
  if (format === "toml") {
    hasTier = tomlHasTopLevelKey(content, "model") || hasSentinelModelTier(content, format);
  } else if (format === "kiro-json") {
    const doc = parseJsonObject(content);
    hasTier = typeof doc?.model === "string" || hasSentinelModelTier(content, format);
  } else {
    const fields = parseFrontmatter(content);
    hasTier = !!(fields && ("model_tier" in fields || "model" in fields)) || hasSentinelModelTier(content, format);
  }
  if (hasTier) return [];
  return [
    {
      surface: "agent-definitions",
      check: "agent-missing-model-tier",
      severity: "low",
      confidence: 0.9,
      path: relativePath,
      message: `${relativePath} has no \`model_tier\` (or \`model\`) declared in its frontmatter.`,
      evidence: { category: "artifact-safety", matchedToken: "frontmatter:model_tier" },
    },
  ];
}

export { lineOfOffset };

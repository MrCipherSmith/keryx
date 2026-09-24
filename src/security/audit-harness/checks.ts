// Flow 308 (W8 Design part A, Lane A) — the audit-harness check catalog.
// One exported pure function per check id, independently testable. Every
// function takes already-read content (never touches the filesystem itself)
// and returns `RawFinding[]` — no id, no suppression: `index.ts` assigns
// those once, after every check has run, against the baseline.

import { detectInjection } from "../detect/injection";
import { detectSecrets } from "../detect/secrets";
import { scanMcpManifest } from "../detect/mcp";
import { touchesAgentCredentials } from "../../lib/command-risk";
import type { AuditSeverity, InternalProposal, RawFinding, SurfaceId } from "./types";

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
  pointer: string,
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
      location: { pointer },
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

export function checkHookSilentSuppression(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  const suppressed = /\|\|\s*true\b/.test(hookCommand) || /2>\/dev\/null/.test(hookCommand) || /;\s*exit\s+0\b/.test(hookCommand);
  if (!suppressed) return [];
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
          patch: `- ${hookCommand}\n+ ${hookCommand.replace(/\s*\|\|\s*true\b/, "").replace(/\s*2>\/dev\/null/, "")}`,
        },
        edit: {
          kind: "text-replace",
          path: relativePath,
          from: hookCommand,
          to: hookCommand.replace(/\s*\|\|\s*true\b/, "").replace(/\s*2>\/dev\/null/, ""),
        },
      },
    },
  ];
}

const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

export function checkHookSilentSuppressionInScript(relativePath: string, content: string): RawFinding[] {
  const match = EMPTY_CATCH_RE.exec(content);
  if (!match) return [];
  return [
    {
      surface: "hooks",
      check: "hook-silent-suppression",
      severity: "high",
      confidence: 0.7,
      path: relativePath,
      location: { line: lineOfOffset(content, match.index) },
      message: `${relativePath} has an empty catch block that silently swallows a hook failure.`,
      evidence: { category: "artifact-safety", matchedToken: "empty-catch" },
    },
  ];
}

// --- agent-definitions -------------------------------------------------------

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

export function checkAgentUnrestrictedTools(relativePath: string, content: string): RawFinding[] {
  const fields = parseFrontmatter(content);
  if (fields && "tools" in fields) return [];
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
  const fields = parseFrontmatter(content);
  if (fields && ("model_tier" in fields || "model" in fields)) return [];
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

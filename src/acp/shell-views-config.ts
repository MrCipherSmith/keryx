// The settings-shaped view commands of `keryx acp --profile shell` (T10b): `/routing`,
// `/jevprofile`, bare `/guard`, `/editguard`, `/projectctx`, `/mcp` and `/bus`.
//
// Each builds its view from the loader the TUI modal reads (no OpenTUI), and its actions are
// text subcommands (`src/commands/shell-subcommands.ts` and the shells' own `on|off` forms),
// so the desktop, the readline shell and the TUI share them.

import { normalizeRoutingConfig } from "../harness/routing/config";
import { readRoutingSettings, ROUTING_NORMALIZATION } from "../harness/routing/settings";
import { ROUTING_CATEGORIES } from "../harness/routing/table";
import { describeRoutingAssignment } from "../harness/routing/trust";
import { readJevProfileForShell } from "../commands/review-jev-profile";
import { loadShellConfig } from "../lib/shell-config";
import { loadEditGuardStatus } from "../tui/jev-edit-guard-inspector";
import { formatProjectContextLastLines, formatProjectContextStatusLines } from "../tui/project-context-inspector";
import { formatProjectReferencesLines } from "../tui/project-references-view";
import { loadMcpServers } from "../mcp-servers/config";
import { transportOf } from "../mcp-servers/doctor";
import { jevProfileApply, jevProfileSet, JEV_PROFILE_USAGE, loadProjectContextStatus, RECOMMENDED_JEV_PROFILE, routingSet, routingTrust, routingTrustPreview, ROUTING_SET_USAGE } from "../commands/shell-subcommands";
import type { ShellCommandHost, ShellCommandOutcome } from "./shell-command-runners";
import { action, viewRow, type ShellView } from "./shell-views";
import { actionOutcome, viewOutcome } from "./shell-views-outcome";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// /routing
// ---------------------------------------------------------------------------

async function routingView(host: ShellCommandHost): Promise<ShellView> {
  const location = { cwd: host.cwd, ...(host.configDir !== undefined ? { configDir: host.configDir } : {}) };
  let settings;
  try {
    settings = readRoutingSettings(location);
  } catch (error) {
    return { title: "Routing", rows: [], body: `routing settings unavailable: ${errorText(error)}` };
  }
  const config = normalizeRoutingConfig(settings.layers, ROUTING_NORMALIZATION);
  const rows = ROUTING_CATEGORIES.map((category) =>
    viewRow(category, category, {
      detail: describeRoutingAssignment(config.categories[category]),
      status: config.categorySources[category],
      actions: [action("Follow the session model", `/routing set ${category} baseline`)],
    }),
  );
  const preview = routingTrustPreview(location);
  if (preview.pending) {
    rows.push(
      viewRow("project-file", "Project routing.config.json", {
        status: "untrusted",
        detail: preview.lines.join("\n"),
        actions: [action("Approve", "/routing trust", `Approve routing.config.json?\n${preview.lines.join("\n")}`)],
      }),
    );
  }
  return {
    title: "Routing",
    rows,
    body: [...settings.notices.map((notice) => `routing: ${notice}`), "Pick a model per category: provider/model, or baseline to follow the session."].join("\n"),
    form: {
      fields: [
        { id: "category", label: "Category", kind: "choice", required: true, options: [...ROUTING_CATEGORIES] },
        { id: "model", label: "provider/model or baseline", kind: "text", required: true, placeholder: "e.g. anthropic/claude-sonnet-5-5 or baseline" },
      ],
      submit: "/routing set {category} {model}",
    },
  };
}

export async function runRouting(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  const location = { cwd: host.cwd, ...(host.configDir !== undefined ? { configDir: host.configDir } : {}) };
  if (args.trim().length === 0) return viewOutcome(await routingView(host));
  if (sub === "set") return actionOutcome(await routingSet(location, rest.join(" ")));
  if (sub === "trust") return actionOutcome(routingTrust(location));
  return { text: `Unknown /routing argument '${sub}'. ${ROUTING_SET_USAGE} | /routing trust\n`, refused: true };
}

// ---------------------------------------------------------------------------
// /jevprofile
// ---------------------------------------------------------------------------

async function jevProfileView(host: ShellCommandHost): Promise<ShellView> {
  let current: Record<string, unknown>;
  try {
    current = await readJevProfileForShell(host.cwd);
  } catch (error) {
    return { title: "Jev profile", rows: [], body: `/jevprofile: ${errorText(error)}` };
  }
  const rows = RECOMMENDED_JEV_PROFILE.map((entry) => {
    const value = current[entry.key];
    const status = typeof value === "boolean" ? (value ? "on" : "off") : "(unset)";
    const target = value === true ? "off" : "on";
    return viewRow(entry.key, `review.jev.${entry.key}`, {
      status,
      detail: `recommended: ${entry.recommended ? "on" : "off"}\n${entry.verdict}`,
      actions: [action(`Turn ${target}`, `/jevprofile set ${entry.key} ${target}`)],
    });
  });
  rows.push(
    viewRow("apply", "Recommended profile", {
      detail: "Writes every recommended review.jev key into .metaproject/tasks.config.json.",
      actions: [action("Apply recommended", "/jevprofile apply", "Apply the recommended review.jev profile to this project's tasks.config.json?")],
    }),
  );
  return { title: "Jev profile", rows, body: "review.jev.* keys next to their measured verdicts." };
}

export async function runJevProfile(host: ShellCommandHost, args: string): Promise<ShellCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (args.trim().length === 0) return viewOutcome(await jevProfileView(host));
  if (sub === "set") return actionOutcome(await jevProfileSet(host.cwd, rest.join(" ")));
  if (sub === "apply") return actionOutcome(await jevProfileApply(host.cwd));
  return { text: `Unknown /jevprofile argument '${sub}'. ${JEV_PROFILE_USAGE}\n`, refused: true };
}

// ---------------------------------------------------------------------------
// /guard, /editguard, /projectctx
// ---------------------------------------------------------------------------

export function guardView(host: ShellCommandHost): ShellView {
  const on = loadShellConfig(host.configDir).turnGuard?.enabled === true;
  return {
    title: "Turn guard",
    body: "The turn guard checks each turn's outcome. Its per-turn history is kept by the full-screen shell for its own session, so there is none to list here.",
    rows: [
      viewRow("enabled", "Turn guard", {
        status: on ? "on" : "off",
        detail: "Saved in the user config; applies to the next keryx shell session.",
        actions: [action(on ? "Turn off" : "Turn on", `/guard ${on ? "off" : "on"}`)],
      }),
    ],
  };
}

export async function editGuardView(host: ShellCommandHost): Promise<ShellView> {
  let status;
  try {
    status = await loadEditGuardStatus(host.cwd);
  } catch (error) {
    return { title: "Edit guard", rows: [], body: `editguard: ${errorText(error)}` };
  }
  const rows = [
    viewRow("enabled", "Jev edit guard", {
      status: status.enabled ? "on" : "off",
      detail: `threshold ${status.threshold} · max ${status.maxCalls} call(s) per edit\ntoday: ${status.today.calls} call(s), ${status.today.flagged} flag(s), $${status.today.costUsd.toFixed(4)}`,
      actions: [action(status.enabled ? "Turn off" : "Turn on", `/editguard ${status.enabled ? "off" : "on"}`)],
    }),
    ...status.recentFlags.map((flag, index) =>
      viewRow(`flag-${index}`, `${flag.file}:${flag.line}`, {
        status: `p=${flag.probability.toFixed(2)}`,
        detail: `${flag.ruleId}#${flag.clauseId} · ${flag.at}`,
      }),
    ),
  ];
  return { title: "Edit guard", rows, body: status.recentFlags.length === 0 ? "No flags recorded yet." : `Recent flags (${status.recentFlags.length}):` };
}

export async function projectContextView(host: ShellCommandHost, tab: "references" | undefined): Promise<ShellView> {
  let status;
  try {
    status = await loadProjectContextStatus(host.cwd);
  } catch (error) {
    return { title: "Project context", rows: [], body: `projectctx: ${errorText(error)}` };
  }
  const next = status.enforcement === "block" ? "warn" : "block";
  const rows = [
    viewRow("enforcement", "Enforcement", {
      status: status.enforcement,
      detail: `${status.enforcementSource} · cap ${status.maxBytes} bytes (${status.maxBytesSource}) · ${status.ruleCount} rule(s), ${status.linkedCount} linked`,
      actions: status.configError === undefined ? [action(`Switch to ${next}`, `/projectctx ${next}`)] : [],
    }),
  ];
  const body =
    tab === "references"
      ? formatProjectReferencesLines(status).join("\n")
      : [...formatProjectContextStatusLines(status), "", ...formatProjectContextLastLines(status)].join("\n");
  return {
    title: tab === "references" ? "Project references" : "Project context",
    rows: tab === "references" ? [] : rows,
    body,
  };
}

// ---------------------------------------------------------------------------
// /mcp, /bus
// ---------------------------------------------------------------------------

export function mcpView(host: ShellCommandHost): ShellView {
  let loaded;
  try {
    loaded = loadMcpServers({ cwd: host.cwd, ...(host.configDir !== undefined ? { configDir: host.configDir } : {}) });
  } catch (error) {
    return { title: "MCP servers", rows: [], body: `mcp: ${errorText(error)}` };
  }
  const rows = loaded.servers.map((server) =>
    viewRow(server.name, server.name, {
      status: server.enabled ? "configured" : "disabled",
      detail: `${server.source} · ${transportOf(server)}${server.projectLocal ? " · project file (needs trust)" : ""}`,
    }),
  );
  const problems = loaded.problems.map((problem) => `config problem — ${problem.file}: ${problem.message}`);
  return {
    title: "MCP servers",
    rows,
    body: [
      "These are the servers keryx would connect to. A live connection is owned by the session; connecting, disconnecting and trusting a server stay in `keryx mcp` (list, doctor, trust) and the full-screen shell.",
      ...(rows.length === 0 ? ["No MCP servers configured."] : []),
      ...problems,
    ].join("\n"),
  };
}

export function busView(): ShellView {
  return {
    title: "Agent bus",
    rows: [],
    body: "bus: off (not joined). keryx acp does not join the agent bus, so there are no peers, leases or log to show. Use keryx shell for the bus.",
  };
}

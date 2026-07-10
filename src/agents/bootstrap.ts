import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { renderGlobalMetaprojectBootstrapBlock } from "../lib/agent-entrypoint-blocks";
import { pathExists } from "../lib/fs";

export const AGENT_BOOTSTRAP_START = "<!-- keryx:global-bootstrap -->";
export const AGENT_BOOTSTRAP_END = "<!-- /keryx:global-bootstrap -->";
export const AGENT_BOOTSTRAP_SENTINEL = "keryx-global-bootstrap";

export type AgentBootstrapRuntimeId =
  | "claude"
  | "opencode"
  | "zcode"
  | "codex"
  | "antigravity";

export type AgentBootstrapRuntime = {
  id: AgentBootstrapRuntimeId;
  aliases: string[];
  label: string;
  fileName: "AGENTS.md" | "CLAUDE.md";
  filePath(homeRoot: string): string;
};

export type AgentBootstrapStatus = {
  runtime: AgentBootstrapRuntimeId;
  label: string;
  filePath: string;
  exists: boolean;
  installed: boolean;
  current: boolean;
};

export type AgentBootstrapInstallResult = AgentBootstrapStatus & {
  wrote: boolean;
  dryRun: boolean;
};

export type AgentBootstrapUninstallResult = AgentBootstrapStatus & {
  removed: boolean;
  dryRun: boolean;
};

export const AGENT_BOOTSTRAP_RUNTIMES: AgentBootstrapRuntime[] = [
  {
    id: "claude",
    aliases: ["claude-code"],
    label: "Claude Code",
    fileName: "CLAUDE.md",
    filePath: (homeRoot) => path.join(homeRoot, ".claude", "CLAUDE.md"),
  },
  {
    id: "opencode",
    aliases: ["open-code"],
    label: "OpenCode",
    fileName: "AGENTS.md",
    filePath: (homeRoot) => path.join(homeRoot, ".config", "opencode", "AGENTS.md"),
  },
  {
    id: "zcode",
    aliases: ["zed", "zed-code"],
    label: "ZCode",
    fileName: "AGENTS.md",
    filePath: (homeRoot) => path.join(homeRoot, ".zcode", "AGENTS.md"),
  },
  {
    id: "codex",
    aliases: [],
    label: "Codex",
    fileName: "AGENTS.md",
    filePath: (homeRoot) => path.join(homeRoot, ".codex", "AGENTS.md"),
  },
  {
    id: "antigravity",
    aliases: ["antigravuty", "antigravity-code"],
    label: "Antigravity",
    fileName: "AGENTS.md",
    filePath: (homeRoot) => path.join(homeRoot, ".config", "antigravity", "AGENTS.md"),
  },
];

export function agentBootstrapRuntimeIds(): AgentBootstrapRuntimeId[] {
  return AGENT_BOOTSTRAP_RUNTIMES.map((runtime) => runtime.id);
}

export function renderAgentBootstrapBlock(fileName: "AGENTS.md" | "CLAUDE.md" = "AGENTS.md"): string {
  return renderGlobalMetaprojectBootstrapBlock({
    startMarker: AGENT_BOOTSTRAP_START,
    endMarker: AGENT_BOOTSTRAP_END,
    fileName,
  });
}

export function resolveAgentBootstrapRuntimes(ids: string[]): {
  runtimes: AgentBootstrapRuntime[];
  unknown: string[];
} {
  const wanted = ids.length === 0 ? ["all"] : ids.flatMap((id) => id.split(",")).map((id) => id.trim()).filter(Boolean);
  const expanded = wanted.includes("all") ? agentBootstrapRuntimeIds() : wanted;
  const runtimes: AgentBootstrapRuntime[] = [];
  const unknown: string[] = [];

  for (const id of expanded) {
    const runtime = AGENT_BOOTSTRAP_RUNTIMES.find((candidate) => candidate.id === id || candidate.aliases.includes(id));
    if (!runtime) {
      unknown.push(id);
      continue;
    }
    if (!runtimes.some((candidate) => candidate.id === runtime.id)) {
      runtimes.push(runtime);
    }
  }

  return { runtimes, unknown };
}

export async function agentBootstrapStatus(
  runtime: AgentBootstrapRuntime,
  homeRoot: string = homedir(),
): Promise<AgentBootstrapStatus> {
  const filePath = runtime.filePath(homeRoot);
  const exists = await pathExists(filePath);
  const content = exists ? await readFile(filePath, "utf8") : "";
  const expected = renderAgentBootstrapBlock(runtime.fileName).trim();
  const installed = content.includes(AGENT_BOOTSTRAP_START);
  const current = installed && extractManagedBlock(content)?.trim() === expected;
  return { runtime: runtime.id, label: runtime.label, filePath, exists, installed, current };
}

export async function installAgentBootstrap(
  runtime: AgentBootstrapRuntime,
  options: { homeRoot?: string; dryRun?: boolean } = {},
): Promise<AgentBootstrapInstallResult> {
  const homeRoot = options.homeRoot ?? homedir();
  const filePath = runtime.filePath(homeRoot);
  const exists = await pathExists(filePath);
  const current = exists ? await readFile(filePath, "utf8") : "";
  const next = upsertManagedBlock(current || defaultAgentFile(runtime), renderAgentBootstrapBlock(runtime.fileName));
  const dryRun = options.dryRun === true;
  const wrote = next !== current;

  if (wrote && !dryRun) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, next, "utf8");
  }

  const status = dryRun
    ? statusFromContent(runtime, filePath, exists, next)
    : await agentBootstrapStatus(runtime, homeRoot);
  return { ...status, wrote, dryRun };
}

export async function uninstallAgentBootstrap(
  runtime: AgentBootstrapRuntime,
  options: { homeRoot?: string; dryRun?: boolean } = {},
): Promise<AgentBootstrapUninstallResult> {
  const homeRoot = options.homeRoot ?? homedir();
  const filePath = runtime.filePath(homeRoot);
  const exists = await pathExists(filePath);
  const current = exists ? await readFile(filePath, "utf8") : "";
  const next = removeManagedBlock(current);
  const dryRun = options.dryRun === true;
  const removed = next !== current;

  if (removed && !dryRun) {
    await writeFile(filePath, next, "utf8");
  }

  const status = dryRun
    ? statusFromContent(runtime, filePath, exists, next)
    : await agentBootstrapStatus(runtime, homeRoot);
  return { ...status, removed, dryRun };
}

function defaultAgentFile(runtime: AgentBootstrapRuntime): string {
  const title = runtime.fileName === "CLAUDE.md" ? "CLAUDE Instructions" : "AGENTS Instructions";
  return `# ${title}\n`;
}

function upsertManagedBlock(content: string, block: string): string {
  const without = removeManagedBlock(content);
  return insertBlockNearTop(without, block);
}

function removeManagedBlock(content: string): string {
  const start = content.indexOf(AGENT_BOOTSTRAP_START);
  if (start < 0) {
    return content;
  }
  const end = content.indexOf(AGENT_BOOTSTRAP_END, start + AGENT_BOOTSTRAP_START.length);
  if (end < 0) {
    return content.slice(0, start).replace(/\n{3,}$/g, "\n\n");
  }
  const afterEnd = end + AGENT_BOOTSTRAP_END.length;
  return `${content.slice(0, start)}${content.slice(afterEnd)}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function extractManagedBlock(content: string): string | null {
  const start = content.indexOf(AGENT_BOOTSTRAP_START);
  if (start < 0) {
    return null;
  }
  const end = content.indexOf(AGENT_BOOTSTRAP_END, start + AGENT_BOOTSTRAP_START.length);
  if (end < 0) {
    return null;
  }
  return content.slice(start, end + AGENT_BOOTSTRAP_END.length);
}

function insertBlockNearTop(content: string, block: string): string {
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  const lines = content.split("\n");
  let insertAt = 0;

  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end >= 0) {
      insertAt = end + 1;
      while (lines[insertAt] === "") {
        insertAt += 1;
      }
    }
  }

  if (/^#\s+/.test(lines[insertAt] ?? "")) {
    insertAt += 1;
  }

  while (lines[insertAt] === "") {
    insertAt += 1;
  }

  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n");
  const prefix = before.length > 0 ? `${before}\n\n` : "";
  const suffix = after.trim().length > 0 ? `\n${after.trimStart()}` : "";
  return `${prefix}${normalizedBlock}${suffix}`;
}

function statusFromContent(
  runtime: AgentBootstrapRuntime,
  filePath: string,
  exists: boolean,
  content: string,
): AgentBootstrapStatus {
  const expected = renderAgentBootstrapBlock(runtime.fileName).trim();
  const installed = content.includes(AGENT_BOOTSTRAP_START);
  const current = installed && extractManagedBlock(content)?.trim() === expected;
  return { runtime: runtime.id, label: runtime.label, filePath, exists, installed, current };
}

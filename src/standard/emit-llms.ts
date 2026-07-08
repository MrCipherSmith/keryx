// `llms.txt` generator (specification.md §10.1; A2/US-A301, AC6, C0-10, F-2).
//
// Pure text over `metaproject.json` + the on-disk artifact index. ZERO runtime
// dependency and fully DETERMINISTIC: no timestamps, all lists sorted, so a
// re-run produces a byte-identical file (F-2). Follows the llms.txt convention:
// an H1 title, a blockquote summary, then link sections.

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathExists, toPosix } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

interface ManifestModuleEntry {
  enabled?: boolean;
  manifest?: string;
  commands?: string[];
}

interface Manifest {
  name?: string;
  standardVersion?: string;
  description?: string;
  modules?: Record<string, ManifestModuleEntry>;
}

export interface EmitLlmsResult {
  path: string;
  content: string;
}

export function llmsPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "llms.txt");
}

// Render the deterministic llms.txt body from a manifest + a sorted artifact
// index. Exported for unit testing without disk I/O.
export function renderLlms(manifest: Manifest, artifacts: string[]): string {
  const name = manifest.name ?? "metaproject";
  const version = manifest.standardVersion ?? "unknown";
  const summary =
    manifest.description ??
    "A CLI-first metaproject workspace: code graph, memory, health, wiki, skills, security, and an MCP server surface for AI agents.";

  const modules = Object.entries(manifest.modules ?? {})
    .filter(([, entry]) => entry?.enabled === true)
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push("");
  lines.push(`> ${summary}`);
  lines.push("");
  lines.push(`Metaproject Standard version: ${version}`);
  lines.push("");

  lines.push("## Modules");
  lines.push("");
  if (modules.length === 0) {
    lines.push("- (no modules enabled)");
  } else {
    for (const { key, entry } of modules) {
      const link = entry.manifest ? toPosix(entry.manifest) : `.metaproject/modules/${key}.md`;
      const commands = Array.isArray(entry.commands) ? [...entry.commands].sort() : [];
      const commandNote = commands.length > 0 ? ` — commands: ${commands.join(", ")}` : "";
      lines.push(`- [${key}](${link})${commandNote}`);
    }
  }
  lines.push("");

  lines.push("## Generated artifacts");
  lines.push("");
  const sortedArtifacts = [...artifacts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sortedArtifacts.length === 0) {
    lines.push("- (none yet — run the modules to generate artifacts)");
  } else {
    for (const artifact of sortedArtifacts) {
      lines.push(`- [${artifact}](${artifact})`);
    }
  }
  lines.push("");

  return `${lines.join("\n").trimEnd()}\n`;
}

async function collectArtifactIndex(cwd: string): Promise<string[]> {
  const dataRoot = path.join(cwd, ".metaproject", "data");
  if (!(await pathExists(dataRoot))) {
    return [];
  }
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = toPosix(path.relative(cwd, full));
        if (rel.includes("/artifacts/")) {
          out.push(rel);
        }
      }
    }
  };
  await walk(dataRoot);
  return out.sort();
}

export async function emitLlms(cwd: string): Promise<EmitLlmsResult> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  const manifest = await readJsonFileOr<Manifest>(manifestPath, {});
  const artifacts = await collectArtifactIndex(cwd);
  const content = renderLlms(manifest, artifacts);
  return { path: llmsPath(cwd), content };
}

// Validate that a string is a well-formed llms.txt: an H1 title on line 1 and a
// blockquote summary. Returns a list of problems; empty = valid (CI validator).
export function validateLlms(content: string): string[] {
  const errors: string[] = [];
  const lines = content.split("\n");
  if (!lines[0]?.startsWith("# ")) {
    errors.push("llms.txt: first line must be an H1 title (`# ...`)");
  }
  if (!lines.some((line) => line.startsWith("> "))) {
    errors.push("llms.txt: missing a `> ` blockquote summary");
  }
  if (!content.endsWith("\n")) {
    errors.push("llms.txt: must end with a trailing newline");
  }
  return errors;
}

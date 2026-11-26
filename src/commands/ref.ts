// `keryx ref` — the linked projects of the current project: other folders
// (usually sibling repositories) the agent is told about and can start a
// subagent in. Stored in `.metaproject/linked-projects.json`.
//
//   keryx ref list [--json]
//   keryx ref add <folder> [--name <name>] [--note <text>] [--json]
//   keryx ref remove <name|folder> [--json]
//
// `--json` is what keryx Desktop reads; every form answers with the full list.

import { resolveProjectRoot } from "../lib/contained-path";
import {
  addLinkedProject,
  LINKED_PROJECTS_PATH,
  removeLinkedProject,
  summarizeLinkedProjects,
  type LinkedProjectSummary,
} from "../lib/linked-projects";

export const REF_USAGE = [
  "keryx ref list [--json]                      Linked projects of this project, with a short summary of each",
  "keryx ref add <folder> [--name <n>] [--note <text>] [--json]",
  "                                             Link a folder (usually a sibling repository)",
  "keryx ref remove <name|folder> [--json]      Unlink it (the folder itself is not touched)",
].join("\n");

export type RefCommandResult = {
  ok: boolean;
  message?: string;
  error?: string;
  projectRoot: string;
  projects: LinkedProjectSummary[];
  warnings: string[];
};

function readFlag(args: string[], flag: string): { value?: string; rest: string[]; error?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === flag) {
      const next = args[index + 1];
      if (next === undefined) return { rest, error: `${flag} needs a value.` };
      value = next;
      index += 1;
    } else if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    } else {
      rest.push(arg);
    }
  }
  return { ...(value === undefined ? {} : { value }), rest };
}

/** The shared core: the shell, ACP and Desktop all run linked-project changes through this. */
export async function runRefAction(projectRoot: string, args: readonly string[]): Promise<RefCommandResult> {
  const [sub = "list", ...restArgs] = args.filter((arg) => arg !== "--json");
  const done = async (fields: { ok: boolean; message?: string; error?: string }): Promise<RefCommandResult> => {
    const { summaries, warnings } = await summarizeLinkedProjects(projectRoot);
    return { ...fields, projectRoot, projects: summaries, warnings };
  };
  try {
    if (sub === "list" || sub === "ls") return await done({ ok: true });
    if (sub === "add") {
      const name = readFlag(restArgs, "--name");
      if (name.error !== undefined) return await done({ ok: false, error: name.error });
      const note = readFlag(name.rest, "--note");
      if (note.error !== undefined) return await done({ ok: false, error: note.error });
      const target = note.rest.join(" ");
      if (target.trim() === "") return await done({ ok: false, error: "Usage: ref add <folder> [--name <name>] [--note <text>]" });
      const added = await addLinkedProject(projectRoot, target, {
        ...(name.value === undefined ? {} : { name: name.value }),
        ...(note.value === undefined ? {} : { note: note.value }),
      });
      return await done({ ok: true, message: `Linked ${added.name} → ${added.root}.` });
    }
    if (sub === "remove" || sub === "rm") {
      const key = restArgs.join(" ");
      if (key.trim() === "") return await done({ ok: false, error: "Usage: ref remove <name|folder>" });
      const removed = await removeLinkedProject(projectRoot, key);
      if (removed === undefined) return await done({ ok: false, error: `No linked project matches "${key}".` });
      return await done({ ok: true, message: `Unlinked ${removed.name} (${removed.root} is untouched).` });
    }
    return await done({ ok: false, error: `Unknown ref command: ${sub}. Use list, add or remove.` });
  } catch (error) {
    return await done({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Human text for one result, shared by the CLI, the TUI and the ACP text runner. */
export function formatRefResult(result: RefCommandResult): string {
  const lines: string[] = [];
  if (result.error !== undefined) lines.push(result.error);
  if (result.message !== undefined) lines.push(result.message);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.projects.length === 0) {
    lines.push(`No linked projects. Add one with: ref add <folder>  (stored in ${LINKED_PROJECTS_PATH})`);
    return lines.join("\n");
  }
  lines.push(`Linked projects (${result.projects.length}):`);
  for (const project of result.projects) {
    const status = project.exists ? "" : "  [missing]";
    lines.push(`  ${project.name}  ${project.root}${status}`);
    if (project.description !== undefined) lines.push(`      ${project.description}`);
    const facts = [
      project.stack.length > 0 ? project.stack.join(", ") : undefined,
      project.keryxIndex !== undefined ? "keryx context" : undefined,
      project.instructions.length > 0 ? project.instructions.join(", ") : undefined,
    ].filter((fact): fact is string => fact !== undefined);
    if (facts.length > 0) lines.push(`      ${facts.join(" · ")}`);
  }
  return lines.join("\n");
}

/** The shell's names for these actions: `/ref <sub>` plus one-word aliases. */
export const REF_SLASH_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "/ref": [],
  "/ref-list": ["list"],
  "/add-ref": ["add"],
  "/ref-remove": ["remove"],
};

export function isRefSlashCommand(name: string): boolean {
  return Object.hasOwn(REF_SLASH_COMMANDS, name);
}

/** `/add-ref ../be --name be` → `["add", "../be", "--name", "be"]`; undefined for any other command. */
export function refArgsFromSlashLine(line: string): string[] | undefined {
  const [name = "", ...rest] = line.trim().split(/\s+/);
  const prefix = REF_SLASH_COMMANDS[name.toLowerCase()];
  if (prefix === undefined) return undefined;
  // A typed line has no quoting: `--note` takes the rest of it, so a note may have spaces.
  const note = rest.indexOf("--note");
  const words = note < 0 || note === rest.length - 1 ? rest : [...rest.slice(0, note + 1), rest.slice(note + 1).join(" ")];
  return [...prefix, ...words];
}

/** Run one `/ref…` line against the project and answer with text, for the TUI and ACP. */
export async function runRefSlashLine(projectRoot: string, line: string, appliesFrom = "the next session"): Promise<string> {
  const args = refArgsFromSlashLine(line) ?? [];
  const result = await runRefAction(projectRoot, args);
  const changed = result.ok && args[0] !== undefined && args[0] !== "list" && args[0] !== "ls";
  const text = formatRefResult(result);
  return changed ? `${text}\nThe agent's system prompt picks this up from ${appliesFrom}.` : text;
}

export async function refCommand(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(REF_USAGE);
    return;
  }
  const result = await runRefAction(resolveProjectRoot(process.cwd()), args);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    // A reader that only looks at the exit code (keryx Desktop) shows stderr as the reason.
    if (!result.ok && result.error !== undefined) console.error(result.error);
  } else console.log(formatRefResult(result));
  if (!result.ok) process.exitCode = 1;
}

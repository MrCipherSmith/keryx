// The project's linked projects: other folders (usually sibling repositories) it organises.
// The Rust command `linked_projects` runs `keryx ref <list|add|remove> --json` in the project,
// so the shell, the CLI and Desktop read and write the same `.metaproject/linked-projects.json`.
import { invoke } from "./backend";
import { errMessage } from "../lib/format";

export interface LinkedProject {
  name: string;
  /** As stored, relative to the project root. */
  path: string;
  /** The absolute folder it points at. */
  root: string;
  exists: boolean;
  gitRepo: boolean;
  description?: string;
  stack: string[];
  keryxIndex?: string;
  instructions: string[];
}

export interface LinkedProjectsResult {
  projects: LinkedProject[];
  warnings: string[];
}

const unsupported = "The selected Keryx CLI does not support linked projects. In Settings → Desktop, choose Bundled keryx or select a newer CLI.";

function isLinkedProject(value: unknown): value is LinkedProject {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && typeof item.path === "string" && typeof item.root === "string"
    && typeof item.exists === "boolean" && Array.isArray(item.stack) && Array.isArray(item.instructions);
}

export function isLinkedProjectsResult(value: unknown): value is LinkedProjectsResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return Array.isArray(result.projects) && result.projects.every(isLinkedProject)
    && Array.isArray(result.warnings) && result.warnings.every((warning) => typeof warning === "string");
}

async function request(cwd: string, args: { action: "list" | "add" | "remove"; target?: string; name?: string }): Promise<LinkedProjectsResult> {
  let response: unknown;
  try {
    response = await invoke("linked_projects", { cwd, ...args });
  } catch (failure) {
    const message = errMessage(failure);
    if (/unknown (command|ref command)|Unknown command: ref\b/i.test(message) || message.startsWith("unavailable: The selected Keryx CLI did not return")) {
      throw new Error(unsupported);
    }
    throw failure;
  }
  if (!isLinkedProjectsResult(response)) throw new Error(unsupported);
  return { projects: response.projects, warnings: response.warnings };
}

export function listLinkedProjects(cwd: string): Promise<LinkedProjectsResult> {
  return request(cwd, { action: "list" });
}

export function addLinkedProject(cwd: string, folder: string, name?: string): Promise<LinkedProjectsResult> {
  return request(cwd, { action: "add", target: folder, ...(name ? { name } : {}) });
}

export function removeLinkedProject(cwd: string, name: string): Promise<LinkedProjectsResult> {
  return request(cwd, { action: "remove", target: name });
}

import { invoke, isTauri } from "./backend";

export type GraphAction = "none" | "check" | "rebuild" | "check-and-rebuild";
export type SetupActionId = "health" | "testingContext" | "projectChecks" | "wikiCollect" | "wikiIndex" | "wikiValidate" | "wikiFreshness";

export interface SetupRequest {
  schemaVersion: 1;
  modules: Record<string, boolean>;
  gdskillsProfile?: string;
  gitignore: boolean;
  sharedAgents: boolean;
  maintenanceOnly?: boolean;
  graph: GraphAction;
  actions: SetupActionId[];
}

interface Module {
  name: string;
  description: string;
  enabled: boolean | null;
  defaultEnabled: boolean;
}

interface Finding {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
  action?: string;
}

export interface SetupInspection {
  root: string;
  enclosingRoot: string | null;
  state: "uninitialized" | "initialized" | "incomplete";
  cliVersion: string;
  writerVersion: string | null;
  compatibility: "current" | "older" | "newer" | "unknown";
  modules: Module[];
  gdskillsProfile: string;
  gdskillsProfiles: string[];
  graphActions: GraphAction[];
  actions: { id: SetupActionId; module: string; runsProjectCommands: boolean }[];
  findings: Finding[];
  lastApply?: { active: string | null; steps: SetupStep[] } | null;
  cliSource: string;
}

interface FileEdit {
  path: string;
  action: "create" | "update" | "unchanged" | "skip" | "conflict" | "remove";
  before?: string | null;
  after?: string;
  detail?: string;
}

interface SetupStep {
  id: string;
  status: "ready" | "skipped" | "completed" | "failed";
  detail?: string;
  exitCode?: number;
}

export interface SetupPlan {
  planId: string;
  root: string;
  mode: "init" | "update" | "repair" | "maintenance";
  status: "ready" | "blocked";
  modules: (Module & { selected: boolean })[];
  steps: SetupStep[];
  blocked: Finding[];
  files: { path: string; outcome: "create" | "update" | "skip" | "conflict"; reason: string | null }[];
  entrypoints: FileEdit[];
  gitignore: FileEdit | null;
  trackedMetaproject: { count: number; examples: string[] } | null;
  ignore: { status: string; gitignoreBlock?: string; exclude?: { status: string; added?: string[]; removed?: string[] } } | null;
}

export interface SetupResult {
  root: string;
  planId: string;
  status: "completed" | "partial";
  journaled: boolean;
  steps: SetupStep[];
}

type Action = { kind: "inspect" } | { kind: "plan"; request: SetupRequest } | { kind: "apply"; request: SetupRequest; planId: string };

export class ProjectSetupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function setup<T>(cwd: string, action: Action): Promise<T & { cliSource: string }> {
  if (!isTauri()) throw new ProjectSetupError("unsupported", "Project setup is available in the native Keryx Desktop app.");
  const { cliSource, result } = await invoke<{ cliSource: string; result: Record<string, unknown> }>("project_setup", { cwd, action });
  const incompatible = () => new ProjectSetupError("incompatible", "The selected CLI returned an invalid project setup response.");
  if (!result || result.schemaVersion !== 1 || result.operation !== action.kind) throw incompatible();
  if (result.status === "error") {
    const error = result.error as { code?: string; message?: string } | undefined;
    throw new ProjectSetupError(error?.code ?? "setup-failed", error?.message ?? "Project setup could not complete.");
  }
  if (typeof result.root !== "string") throw incompatible();
  switch (action.kind) {
    case "inspect":
      if (!["uninitialized", "initialized", "incomplete"].includes(String(result.state)) || !Array.isArray(result.modules)
        || !Array.isArray(result.findings) || !Array.isArray(result.actions) || !Array.isArray(result.graphActions)
        || !Array.isArray(result.gdskillsProfiles)) throw incompatible();
      break;
    case "plan":
      if (!["ready", "blocked"].includes(String(result.status)) || !Array.isArray(result.steps) || !Array.isArray(result.modules)
        || !Array.isArray(result.blocked) || !Array.isArray(result.files) || !Array.isArray(result.entrypoints)
        || typeof result.planId !== "string" || !/^[a-f0-9]{64}$/.test(result.planId)) throw incompatible();
      break;
    case "apply":
      if (!["completed", "partial"].includes(String(result.status)) || !Array.isArray(result.steps) || result.planId !== action.planId) throw incompatible();
      break;
  }
  return { ...(result as T), cliSource };
}

export const inspectProjectSetup = (cwd: string) => setup<SetupInspection>(cwd, { kind: "inspect" });
export const planProjectSetup = (cwd: string, request: SetupRequest) => setup<SetupPlan>(cwd, { kind: "plan", request });
export const applyProjectSetup = (cwd: string, request: SetupRequest, planId: string) => setup<SetupResult>(cwd, { kind: "apply", request, planId });

export function shouldOfferProjectSetup(report: SetupInspection): boolean {
  return report.state !== "initialized" || report.compatibility === "older" || report.compatibility === "newer"
    || report.findings.some(({ severity, action }) => severity === "error" || action === "update" || action === "replan");
}

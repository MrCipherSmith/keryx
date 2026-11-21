import { invoke, isTauri, listen } from "./backend";
import type { SetupInspection } from "./projectSetup";

export interface ProjectCheck {
  cwd: string;
  root: string;
  checkedAt: number;
  status: "checked" | "unavailable" | "cli-configuration" | "error";
  report: SetupInspection | null;
  error: string | null;
}

export type ScanKind = "startup" | "refresh" | "afterApply";

export function scanProjects(kind: ScanKind) {
  return isTauri() ? invoke<void>("project_diagnostics", { kind }) : Promise.resolve();
}

export const onProjectDiagnostics = (listener: (snapshot: ProjectCheck[]) => void) =>
  listen<ProjectCheck[]>("project-diagnostics://updated", listener, "app");

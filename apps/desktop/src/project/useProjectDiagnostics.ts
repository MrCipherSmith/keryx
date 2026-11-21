import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../platform/backend";
import { onProjectDiagnostics, scanProjects, type ProjectCheck, type ScanKind } from "../platform/projectDiagnostics";
import { errMessage } from "../lib/format";
import type { SetupInspection, SetupRequest } from "../platform/projectSetup";

export interface ProjectNotice {
  key: string;
  fingerprint: string;
  cwd: string;
  checkedAt: number;
  finding: string;
  message: string;
  target: "setup" | "desktop" | "retry";
}

export function projectNotices(checks: readonly ProjectCheck[]): ProjectNotice[] {
  const notices = new Map<string, ProjectNotice>();
  for (const { cwd, root, checkedAt, status, report, error } of checks) {
    const add = (finding: string, message: string, target: ProjectNotice["target"], evidence?: unknown) => {
      const key = JSON.stringify([target === "desktop" && finding === "cli-configuration" ? "" : root, finding]);
      if (!notices.has(key)) {
        notices.set(key, { key, fingerprint: JSON.stringify([message, evidence ?? null]), cwd, checkedAt, finding, message, target });
      }
    };
    if (!report || status !== "checked") {
      add(status, error ?? "The project could not be checked.", status === "cli-configuration" ? "desktop" : "retry");
      continue;
    }
    if (report.state === "uninitialized" && !report.enclosingRoot) {
      add("setup-needed", "Metaproject is not initialized.", "setup");
    }
    for (const finding of report.findings) {
      const { id, message, severity } = finding;
      if (id === "unknown-writer") continue;
      if (id === "newer-project-writer") {
        add(id, message, "desktop", [report.cliVersion, report.writerVersion]);
      } else if (severity !== "info" || id === "update-available") {
        add(id, message, "setup", id === "update-available" ? [report.cliVersion, report.writerVersion] : undefined);
      }
    }
  }
  return [...notices.values()].sort((a, b) => b.checkedAt - a.checkedAt || a.key.localeCompare(b.key));
}

/** Map fresh diagnostic IDs to known request options. CLI fix text is display-only. */
export function setupRequestForFinding(report: SetupInspection, finding: string | undefined): Partial<SetupRequest> {
  if (report.state !== "initialized") return {};
  if (finding === undefined || finding === "setup-needed") return {};
  if (!report.findings.some(({ id }) => id === finding)) return { maintenanceOnly: true };
  switch (finding) {
    case "graph-freshness":
      return { maintenanceOnly: true, graph: "check-and-rebuild" };
    case "wiki-freshness":
      return { maintenanceOnly: true, actions: ["wikiFreshness"] };
    case "incomplete-setup": {
      const unfinished = new Set([
        report.lastApply?.active,
        ...(report.lastApply?.steps ?? []).filter(({ status }) => status === "failed" || status === "skipped").map(({ id }) => id),
      ]);
      const actions = report.actions.filter(({ id }) => unfinished.has(id)).map(({ id }) => id);
      const graph = unfinished.has("graph") ? "check-and-rebuild" : "none";
      const refresh = ["init", "update", "configure", "gitignore"].some((id) => unfinished.has(id));
      return { actions, graph, gitignore: unfinished.has("gitignore"), maintenanceOnly: !refresh && (actions.length > 0 || graph !== "none") };
    }
    case "update-available":
    case "entrypoints":
    case "commit-msg-hook":
    case "interrupted-install":
    case "standard":
      return {};
    default:
      return { maintenanceOnly: true };
  }
}

type NoticeMemory = Record<string, { fingerprint: string; dismissed: boolean }>;
const MEMORY_KEY = "keryx.project-diagnostics-notices.v1";

function readMemory(): NoticeMemory {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as NoticeMemory : {};
  } catch {
    return {};
  }
}

export function reconcileNoticeMemory(memory: NoticeMemory, checks: readonly ProjectCheck[]): NoticeMemory {
  const observed = new Set(checks.map((check) => check.root));
  const healthy = new Set(checks.filter(({ status }) => status === "checked").map(({ root }) => root));
  const active = new Set(projectNotices(checks).map(({ key }) => key));
  return Object.fromEntries(Object.entries(memory).filter(([key]) => {
    try {
      const [root, finding] = JSON.parse(key) as [string, string];
      if (active.has(key)) return true;
      if (root === "" && finding === "cli-configuration") return healthy.size === 0;
      const probeFailure = ["unavailable", "error"].includes(finding);
      return !(probeFailure ? observed : healthy).has(root);
    } catch {
      return false;
    }
  }));
}

function saveMemory(memory: NoticeMemory): void {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch { /* Memory stays available for this view. */ }
}

export function useProjectDiagnostics(cwd: string | null | undefined) {
  const [checks, setChecks] = useState<ProjectCheck[]>([]);
  const [memory, setMemory] = useState(readMemory);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const total = useRef(0);
  const scan = useCallback(async (kind: ScanKind) => {
    total.current += 1;
    setScanning(true);
    setError("");
    try {
      await scanProjects(kind);
    } catch (failure) {
      if (active.current) setError(errMessage(failure));
    } finally {
      total.current -= 1;
      if (active.current && total.current === 0) setScanning(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    const refreshMemory = (event: StorageEvent) => {
      if (event.key === MEMORY_KEY) setMemory(readMemory());
    };
    window.addEventListener("storage", refreshMemory);
    return () => {
      active.current = false;
      window.removeEventListener("storage", refreshMemory);
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || cwd === undefined) return;
    let live = true;
    let off: (() => void) | undefined;
    void onProjectDiagnostics((snapshot) => {
      if (!live || !Array.isArray(snapshot)) return;
      setChecks(snapshot);
      const before = readMemory();
      const next = reconcileNoticeMemory(before, snapshot);
      if (Object.keys(before).length !== Object.keys(next).length) saveMemory(next);
      setMemory(next);
    }).then((stop) => {
      if (live) {
        off = stop;
        void scan("startup");
      } else stop();
    }).catch((failure: unknown) => { if (live) setError(errMessage(failure)); });
    return () => { live = false; off?.(); };
  }, [cwd, scan]);

  const all = projectNotices(checks);
  const notices = all.filter((notice) =>
    !(memory[notice.key]?.fingerprint === notice.fingerprint && memory[notice.key]?.dismissed));
  const unread = notices.filter((notice) => memory[notice.key]?.fingerprint !== notice.fingerprint).length;

  const acknowledge = (notice: ProjectNotice, dismissed = false) => {
    const next = { ...memory, ...readMemory(), [notice.key]: { fingerprint: notice.fingerprint, dismissed } };
    // Recents are bounded and the memory can retain a small number of older projects.
    const recent = Object.fromEntries(Object.entries(next).slice(-200));
    saveMemory(recent);
    setMemory(recent);
  };
  return { notices, unread, scanning, error, scan, acknowledge };
}

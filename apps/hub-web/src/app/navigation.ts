import { useSyncExternalStore } from "react";
export type Tab =
  | "overview"
  | "flows"
  | "documents"
  | "proposals"
  | "code"
  | "delivery"
  | "history"
  | "machines"
  | "sessions"
  | "runs"
  | "work";
export type HubLocation = {
  projectId: string | null;
  tab: Tab;
  documentId?: string;
  flowId?: string;
  intentId?: string;
  attemptId?: string;
  revisionId?: string;
  sessionId?: string;
  runId?: string;
  machineId?: string;
};
export const tabs: Tab[] = [
  "overview",
  "flows",
  "documents",
  "proposals",
  "code",
  "delivery",
  "history",
  "machines",
  "sessions",
  "runs",
  "work",
];
function read(): HubLocation {
  const p = new URLSearchParams(window.location.search);
  const candidate = p.get("view");
  return {
    projectId: p.get("project"),
    tab: tabs.includes(candidate as Tab) ? (candidate as Tab) : "overview",
    documentId: p.get("document") ?? undefined,
    flowId: p.get("flow") ?? undefined,
    revisionId: p.get("revision") ?? undefined,
    sessionId: p.get("session") ?? undefined,
    runId: p.get("run") ?? undefined,
    machineId: p.get("machine") ?? undefined,
    ...(p.get("intent") ? { intentId: p.get("intent")! } : {}),
    ...(p.get("attempt") ? { attemptId: p.get("attempt")! } : {}),
  };
}
let location = read();
const listeners = new Set<() => void>();
function emit() {
  location = read();
  listeners.forEach((l) => l());
}
window.addEventListener("popstate", emit);
export function navigate(patch: Partial<HubLocation>, replace = false) {
  const next = { ...location, ...patch };
  if (patch.projectId !== undefined && patch.projectId !== location.projectId) {
    next.documentId = patch.documentId;
    next.flowId = patch.flowId;
    next.revisionId = patch.revisionId;
    next.sessionId = patch.sessionId;
    next.runId = patch.runId;
    next.machineId = patch.machineId;
    next.intentId = patch.intentId;
    next.attemptId = patch.attemptId;
  }
  if (patch.flowId !== undefined && patch.flowId !== location.flowId) {
    next.intentId = patch.intentId;
    next.attemptId = patch.attemptId;
  }
  if (patch.tab && patch.tab !== "work") {
    next.intentId = undefined;
    next.attemptId = undefined;
  }
  const p = new URLSearchParams();
  if (next.projectId) p.set("project", next.projectId);
  if (next.tab !== "overview") p.set("view", next.tab);
  if (next.documentId) p.set("document", next.documentId);
  if (next.flowId) p.set("flow", next.flowId);
  if (next.revisionId) p.set("revision", next.revisionId);
  if (next.sessionId) p.set("session", next.sessionId);
  if (next.runId) p.set("run", next.runId);
  if (next.machineId) p.set("machine", next.machineId);
  if (next.intentId) p.set("intent", next.intentId);
  if (next.attemptId) p.set("attempt", next.attemptId);
  const url = "/" + (p.size ? "?" + p.toString() : "");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
  emit();
}
export function resetNavigation() {
  navigate(
    {
      projectId: null,
      tab: "overview",
      documentId: undefined,
      flowId: undefined,
      revisionId: undefined,
      sessionId: undefined,
      runId: undefined,
      machineId: undefined,
      intentId: undefined,
      attemptId: undefined,
    },
    true,
  );
}
export function useLocation() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => location,
  );
}

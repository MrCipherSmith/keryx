// Structured Work-card data and an embedded view of the existing inspectors.
import type { SidebarSnapshot } from "./sidebar-cards";
import type { ModalChrome } from "./modal-host";
import { presentSubagentInspector, type OpenModalFn, type OpenModalInput } from "./subagent-inspector";
import { presentJobInspector, type JobKillCapability } from "./background-job-inspector";
import type { SubagentSession, SubagentSessionStore } from "./subagent-session";
import type { BackgroundJobEntry, BackgroundJobStore } from "./background-job-session";
import { roleColor } from "./theme";

type AgentRow = Pick<SubagentSession, "id" | "label" | "status">;
type JobRow = Pick<BackgroundJobEntry, "jobId" | "command" | "status">;

function counts(label: string, statuses: readonly string[], done: string): string {
  const n = (status: string): number => statuses.filter((value) => value === status).length;
  const failures = n("failed") + n("killed");
  return `${label} ${n("running")}/${n(done)}`
    + (n("queued") > 0 ? ` · ${n("queued")} queued` : "")
    + (n("blocked") > 0 ? ` · ${n("blocked")} blocked` : "")
    + (failures > 0 ? ` · ${failures} failed` : "");
}

export function workSidebarSnapshot(agents: readonly AgentRow[], jobs: readonly JobRow[]): SidebarSnapshot {
  return {
    sections: {
      ...(agents.length > 0 ? { subagents: counts("Subagents", agents.map((a) => a.status), "done") } : {}),
      ...(jobs.length > 0 ? { jobs: counts("Jobs", jobs.map((j) => j.status), "completed") } : {}),
    },
    items: {
      subagents: agents.map((a) => ({ id: a.id, label: a.label, text: `${a.status} · ${a.label}` })),
      jobs: jobs.map((j) => ({ id: j.jobId, label: j.command, text: `${j.status} · ${j.command}` })),
    },
  };
}

type OpenTui = typeof import("@opentui/core");

/** Adapt an existing inspector to a tab body instead of replacing the modal host. */
function embeddedInspector(
  otui: OpenTui, chrome: ModalChrome, body: unknown,
): { open: OpenModalFn; dispose(): void } {
  let dispose = (): void => {};
  const open: OpenModalFn = (_otui, _chrome, input: OpenModalInput) => {
    const parent = body as { add(child: unknown): void };
    const nav = new otui.BoxRenderable(chrome.renderer, { id: "embedded-inspector-tabs", flexDirection: "row", flexShrink: 0 });
    const content = new otui.BoxRenderable(chrome.renderer, { id: "embedded-inspector-content", flexDirection: "column", flexGrow: 1, minHeight: 0 });
    parent.add(nav);
    parent.add(content);
    let active = input.initialTab ?? input.tabs[0]?.id ?? "";
    let cleanup: (() => void) | undefined;
    const buttons = new Map<string, InstanceType<OpenTui["TextRenderable"]>>();
    const mount = (id: string): void => {
      if (!input.tabs.some((tab) => tab.id === id)) return;
      cleanup?.();
      cleanup = undefined;
      for (const child of [...content.getChildren()]) {
        content.remove(child);
        child.destroy();
      }
      active = id;
      for (const [tabId, button] of buttons) button.fg = roleColor(tabId === id ? "text" : "muted");
      const result = input.renderTab(id, content);
      if (typeof result === "function") cleanup = result;
      chrome.renderer.requestRender();
    };
    for (const tab of input.tabs) {
      const button = new otui.TextRenderable(chrome.renderer, {
        id: `embedded-inspector-tab-${tab.id}`, content: `[ ${tab.label} ] `,
        onMouseDown: () => mount(tab.id),
      });
      buttons.set(tab.id, button);
      nav.add(button);
    }
    mount(active);
    let closed = false;
    dispose = (): void => {
      if (closed) return;
      closed = true;
      cleanup?.();
      input.onClose?.();
    };
    return { close: () => dispose(), setTab: mount, activeTab: () => active };
  };
  return { open, dispose: () => dispose() };
}

export function renderWorkInspector(
  otui: OpenTui, chrome: ModalChrome, body: unknown, section: string, id: string,
  options: { agents: SubagentSessionStore; jobs: BackgroundJobStore; registry: JobKillCapability },
): () => void {
  const embedded = embeddedInspector(otui, chrome, body);
  const handle = section === "subagents"
    ? presentSubagentInspector(embedded.open, otui, chrome, { store: options.agents, id, renderer: chrome.renderer })
    : presentJobInspector(embedded.open, otui, chrome, { store: options.jobs, id, registry: options.registry, renderer: chrome.renderer });
  if (handle === undefined) {
    (body as { add(child: unknown): void }).add(new otui.TextRenderable(chrome.renderer, {
      id: "embedded-inspector-gone", content: "This worker is gone.", fg: roleColor("muted"),
    }));
  }
  return embedded.dispose;
}

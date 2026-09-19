// `/bus` modal — Peers / Leases / Log tabs (flow 273 T7; specification §7.2).
//
// Presentation only, same shape as `session-info.ts`/`flow-inspector.ts`: pure
// line-formatting functions (testable without a renderer) plus a thin
// `openModal` host wiring. No selection/keypress handling — all three tabs are
// a static snapshot taken when the modal opens, same as `/status`'s tabs.

import type { BusPeer, RenderableBusEventKind } from "../bus/client";
import { displaySafe } from "../bus/display";
import type { BusEvent, PauseLease } from "../bus/schema";
import { openModal } from "./modal-host";

/**
 * One transcript line for an addressed event (specification §5.2, T7
 * dispatch): `⇄ @from kind: preview`. Rendered through the shell's normal
 * `io.onSystem` (dim, unless it matches the `[error]` pattern that path
 * already special-cases — never that here), so it must work while busy.
 */
export function formatBusEventLine(fromName: string, kind: RenderableBusEventKind, preview: string): string {
  return `⇄ @${fromName} ${kind}: ${preview}`;
}

export type ModalTab = { id: string; label: string };

export type OpenModalFn = (otui: unknown, chrome: unknown, input: {
  title: string;
  tabs: readonly ModalTab[];
  initialTab?: string;
  footer?: readonly { key: string; label: string }[];
  renderTab: (tabId: string, body: unknown, ctx?: { width: number }) => void | (() => void);
  onClose?: () => void;
}) => ModalHandle | undefined;

export type ModalHandle = {
  close(): void;
  setTab(id: string): void;
  activeTab(): string;
};

export const BUS_MODAL_FOOTER = [
  { key: "←/→", label: "tabs" },
  { key: "esc", label: "close" },
] as const;

/** Peers tab: live/stale, name, status, activity, checkout, branch (T7 dispatch). */
export function formatBusPeersLines(peers: readonly BusPeer[]): string[] {
  if (peers.length === 0) {
    return ["No other instances on this bus."];
  }
  return peers.map((peer) => {
    const marker = peer.state === "live" ? "● live " : "◌ stale";
    const branch = peer.record.branch ?? "—";
    const activity = peer.record.activity.length > 0 ? peer.record.activity : "—";
    return `${marker}  @${peer.record.name}  ${peer.record.status}  ${peer.record.checkout} (${branch})  ${activity}`;
  });
}

/** Leases tab: active pause leases only (`listActiveLeases`), read-only. */
export function formatBusLeasesLines(leases: readonly PauseLease[]): string[] {
  if (leases.length === 0) {
    return ["No active leases."];
  }
  return leases.map((lease) => {
    const targets = lease.targets.length === 1 && lease.targets[0] === "*" ? "@all" : lease.targets.join(",");
    return `${lease.scope}  @${lease.holder.name} → ${targets}  "${lease.reason}"  until ${lease.expiresAt}`;
  });
}

/** Log tab: the last 50 events, `displaySafe`d (T7 dispatch: "via readEvents from start"). */
export function formatBusLogLines(events: readonly BusEvent[]): string[] {
  if (events.length === 0) {
    return ["No events yet."];
  }
  return events.slice(-50).map((event) => {
    const preview = displaySafe(event.body ?? "").slice(0, 160);
    return `#${event.seq}  @${event.from.name} → ${event.toLabel}  ${event.kind}${preview.length > 0 ? `: ${preview}` : ""}`;
  });
}

function wrapBlock(text: string, width: number): string {
  if (width < 8) {
    return text;
  }
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) {
        return [line];
      }
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += width) {
        chunks.push(line.slice(i, i + width));
      }
      return chunks;
    })
    .join("\n");
}

function paintContent(otui: unknown, renderer: unknown, body: unknown, content: string, width?: number): void {
  if (otui === undefined || otui === null || body === undefined || body === null) {
    return;
  }
  const parent = body as { add?: (child: unknown) => void };
  const ctor = (otui as { TextRenderable?: new (r: unknown, opts: { id: string; content: string }) => unknown }).TextRenderable;
  if (parent.add === undefined || ctor === undefined) {
    return;
  }
  const next = width !== undefined ? wrapBlock(content, width) : content;
  parent.add(new ctor(renderer, { id: "bus-body", content: next }));
}

export type PresentBusOptions = {
  peers: readonly BusPeer[];
  leases: readonly PauseLease[];
  events: readonly BusEvent[];
  renderer?: unknown;
};

export function presentBus(openModalFn: OpenModalFn, otui: unknown, chrome: unknown, options: PresentBusOptions): ModalHandle | undefined {
  return openModalFn(otui, chrome, {
    title: "/bus",
    tabs: [
      { id: "peers", label: "Peers" },
      { id: "leases", label: "Leases" },
      { id: "log", label: "Log" },
    ],
    initialTab: "peers",
    footer: BUS_MODAL_FOOTER,
    renderTab: (tabId, body, ctx) => {
      const renderer = options.renderer ?? (chrome as { renderer?: unknown } | undefined)?.renderer;
      const width = ctx?.width;
      if (tabId === "peers") {
        paintContent(otui, renderer, body, formatBusPeersLines(options.peers).join("\n"), width);
        return;
      }
      if (tabId === "leases") {
        paintContent(otui, renderer, body, formatBusLeasesLines(options.leases).join("\n"), width);
        return;
      }
      paintContent(otui, renderer, body, formatBusLogLines(options.events).join("\n"), width);
    },
  });
}

/** Open the shared host on Peers/Leases/Log. No-op when OpenTUI/chrome is missing. */
export function openBus(otui: Parameters<typeof openModal>[0], chrome: Parameters<typeof openModal>[1], options: PresentBusOptions): ModalHandle | undefined {
  return presentBus(
    (hostOtui, hostChrome, input) => openModal(hostOtui as typeof otui, hostChrome as typeof chrome, input),
    otui,
    chrome,
    options,
  );
}

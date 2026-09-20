// `/bus` modal — Peers / Leases / Log tabs (flow 273 T7; specification §7.2).
//
// Presentation only, same shape as `session-info.ts`/`flow-inspector.ts`: pure
// line-formatting functions (testable without a renderer) plus a thin
// `openModal` host wiring. No selection/keypress handling — all three tabs are
// a static snapshot taken when the modal opens, same as `/status`'s tabs.

import type { BusPeer } from "../bus/client";
import { displaySafe } from "../bus/display";
import type { BusEvent, PauseLease } from "../bus/schema";
import { openModal } from "./modal-host";

// review r1 F4: transcript event lines are `../bus/display`'s
// `formatBusEventLine(RenderedBusEvent)` now — the ONE place both the
// readline shell and the TUI format an event line — so this module no longer
// keeps its own copy. `tui-shell.ts` imports that function directly.

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

/**
 * Peers tab: live/stale, name, status, activity, checkout, branch (T7
 * dispatch). `name`, `checkout`, `branch` and `activity` are peer-supplied
 * free text (specification §4.1) — `displaySafe`d before they reach the
 * operator's terminal (review r1 F3); `status` is one of the closed
 * `PresenceStatus` enum values and needs no sanitizing.
 */
export function formatBusPeersLines(peers: readonly BusPeer[]): string[] {
  if (peers.length === 0) {
    return ["No other instances on this bus."];
  }
  return peers.map((peer) => {
    const marker = peer.state === "live" ? "● live " : "◌ stale";
    const name = displaySafe(peer.record.name);
    const branch = peer.record.branch === null ? "—" : displaySafe(peer.record.branch);
    const checkout = displaySafe(peer.record.checkout);
    const activity = peer.record.activity.length > 0 ? displaySafe(peer.record.activity) : "—";
    return `${marker}  @${name}  ${peer.record.status}  ${checkout} (${branch})  ${activity}`;
  });
}

/**
 * A lease's `targets` names this instance (specification §4.3: `["*"]` reads
 * as "every instance but the holder" — D-03, a lease never targets its own
 * holder). Flow 275 (agent bus P4) T7: the Leases tab's own "applies to
 * you" marker. Deliberately does NOT account for a local `override` — that
 * state lives inside `PauseLeaseView` (`../bus/pause.ts`), which exposes no
 * per-lease query for it, only the aggregate `appliesToMe(scope)`/`heldBy()`
 * the hold/banner logic already uses; a read-only tab marking a just-
 * overridden lease as still "applying" for one more poll is a display nit,
 * never a functional one (the actual hold is governed by `leaseView.held()`,
 * not by this marker).
 */
function leaseTargetsInstance(lease: PauseLease, instanceId: string): boolean {
  if (lease.holder.instanceId === instanceId) return false;
  return lease.targets.includes(instanceId) || (lease.targets.length === 1 && lease.targets[0] === "*");
}

/**
 * Leases tab: active pause leases only (`listActiveLeases`), read-only.
 * `reason` and the holder's `name` are peer-supplied free text — `displaySafe`d
 * before they reach the operator's terminal (review r1 F3). `selfInstanceId`
 * (flow 275 T7), when given, marks each lease that targets this instance
 * (`leaseTargetsInstance` above) so the operator can tell at a glance which
 * leases actually bind them.
 */
export function formatBusLeasesLines(leases: readonly PauseLease[], selfInstanceId?: string): string[] {
  if (leases.length === 0) {
    return ["No active leases."];
  }
  return leases.map((lease) => {
    const targets = lease.targets.length === 1 && lease.targets[0] === "*" ? "@all" : lease.targets.join(",");
    const holderName = displaySafe(lease.holder.name);
    const reason = displaySafe(lease.reason);
    const mine = selfInstanceId !== undefined && leaseTargetsInstance(lease, selfInstanceId);
    const marker = mine ? "→ you  " : "";
    return `${marker}${lease.scope}  @${holderName} → ${targets}  "${reason}"  until ${lease.expiresAt}`;
  });
}

/**
 * Log tab: the last 50 events, `displaySafe`d (T7 dispatch: "via readEvents
 * from start"). Shows both `#seq` and the event's short id (review r1 F4) —
 * the same 8-character prefix `../bus/client`'s `resolveRef`/`/bus reply`
 * accept — so an operator can copy either into `/bus reply <ref>`.
 * `fromName`, `toLabel` and the body preview are all peer-supplied free text,
 * `displaySafe`d before they reach the operator's terminal (review r1 F3).
 */
export function formatBusLogLines(events: readonly BusEvent[]): string[] {
  if (events.length === 0) {
    return ["No events yet."];
  }
  return events.slice(-50).map((event) => {
    const shortId = event.id.slice(0, 8);
    const fromName = displaySafe(event.from.name);
    const toLabel = displaySafe(event.toLabel);
    const preview = displaySafe(event.body ?? "").slice(0, 160);
    return `#${event.seq} [${shortId}]  @${fromName} → ${toLabel}  ${event.kind}${preview.length > 0 ? `: ${preview}` : ""}`;
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
  /** Flow 275 T7: this instance's id, so the Leases tab can mark which leases apply to it. */
  selfInstanceId?: string;
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
        paintContent(otui, renderer, body, formatBusLeasesLines(options.leases, options.selfInstanceId).join("\n"), width);
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

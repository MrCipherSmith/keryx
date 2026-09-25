// Flow 308 (W8, Lane B, T6): "is a `pre-tool-context` surface actually wired
// up anywhere yet" — read-only, off the one harness-adapter registry
// (`src/integrations`, core zone; this is the read-only import the plan
// allows). No surface flagged `pre-tool-context` is registered as
// `verified` today, so every adapter reports `not-registered` — this module
// exists so that answer comes from the registry, not from memory, the
// moment W6/W5-b actually wires one up.

import { HARNESS_ADAPTERS, surfacesOf } from "../../integrations";

export type HostDeliveryStatus = "verified" | "experimental" | "not-registered";

export interface HostDeliveryEntry {
  adapterId: string;
  label: string;
  status: HostDeliveryStatus;
}

/**
 * For every registered harness adapter: whether it has a `pre-tool-context`
 * surface, and if so whether the registry marks that surface's adapter
 * `verified` or merely `experimental`. An adapter with no such surface at
 * all is `not-registered` — today, that is every adapter.
 */
export function hostDeliveryStatus(): HostDeliveryEntry[] {
  return HARNESS_ADAPTERS.map((adapter) => {
    const preToolContext = surfacesOf(adapter, { flag: "pre-tool-context" });
    const status: HostDeliveryStatus =
      preToolContext.length === 0 ? "not-registered" : adapter.confidence === "verified" ? "verified" : "experimental";
    return { adapterId: adapter.id, label: adapter.label, status };
  });
}

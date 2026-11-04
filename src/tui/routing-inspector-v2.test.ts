import { expect, test } from "bun:test";
import { normalizeRoutingV2Config } from "../harness/routing/config-v2";
import type { ModelProfile } from "../harness/routing/model-profile";
import { profileKey } from "../harness/routing/model-profile";
import { formatRoutingV2ListLines, previewCatalogRoutingCategoriesV2 } from "./routing-inspector";

const target = { providerId: "alpha", modelId: "expert" };
const profile: ModelProfile = {
  ...target, strengthTier: { value: "deep", source: "operator" },
  priceInputPerMillion: { value: 1, source: "operator" }, priceOutputPerMillion: { value: 2, source: "operator" },
  contextLength: { value: 100_000, source: "operator" }, priority: { value: 1, source: "operator" },
  available: true, chatCapable: true, lastSeenAt: "2026-11-04T00:00:00.000Z", refreshedAt: "2026-11-04T00:00:00.000Z",
};

test("v2 inspector preview uses the shared resolver and receipt", () => {
  const config = normalizeRoutingV2Config({ user: { schemaVersion: 2,
    classes: { expert: { candidates: [{ target, enabled: true, priority: 1 }], selection: "priority", fallbackClasses: [] } },
    categories: { review: { mode: "class", modelClass: "expert" }, coding: { mode: "auto" } },
  } });
  const rows = previewCatalogRoutingCategoriesV2({
    config, providers: [{ name: "alpha", models: ["expert"] }], profiles: { [profileKey("alpha", "expert")]: profile }, baseline: target,
    policy: { credentialsAvailable: () => true, policyAllowed: () => true, parentAllowed: () => true, capabilities: () => [], cooldown: () => false, observedLatencyMs: () => null },
    now: () => new Date("2026-11-04T00:04:00.000Z"),
  });
  expect(rows.find((row) => row.category === "review")?.receipt.decision).toMatchObject({ status: "selected", selection: target });
  expect(rows.find((row) => row.category === "coding")?.receipt.decision.status).toBe("needs-classification");
  expect(formatRoutingV2ListLines(rows, 0).find((line) => line.includes("review"))).toContain("alpha/expert");
});

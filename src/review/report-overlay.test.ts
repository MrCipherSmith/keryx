import { expect, test } from "bun:test";
import { embeddedReportSlots, projectReportSlots, publicProjectReport, retainProjectReportOverlay, type ReviewOverlay } from "./report-overlay";

const vantage: ReviewOverlay = { kind: "slots", id: "vantage-review", source: "", names: ["verified-clean", "how-run"],
  requiresApproval: true, rereadDiscussion: true };

test("Vantage report ingest keeps check evidence and renders every mandatory check", () => {
  const evidence = "- **Testing gate** — Existing integration test covers the behavior.\n- Live run — Not run: static review only.";
  const slots = { overlay: "vantage-review", slots: { "verified-clean": evidence, "how-run": "The project reviewer inspected the diff." } };
  const input = ["# Review", "", "Evidence level: static only", "", "<!-- slot:verified-clean -->", "",
    "```keryx:report-slots", JSON.stringify(slots), "```"].join("\n");
  const saved = retainProjectReportOverlay(vantage, input);
  expect(retainProjectReportOverlay(vantage, saved)).toBe(saved);
  const stored = JSON.parse(embeddedReportSlots(saved)!);
  expect(stored.slots["verified-clean"].split("\n").filter((line: string) => line.startsWith("- "))).toHaveLength(9);
  expect(stored.slots["verified-clean"]).toContain("Testing gate — Existing integration test covers the behavior.");
  expect(stored.slots["verified-clean"]).toContain("Live run — Not run: static review only.");
  expect(stored.slots["verified-clean"]).toContain("Owner intent — Not verified in this round.");
  expect(projectReportSlots(vantage, saved, 1, "changes", true)["verified-clean"]).toBe(stored.slots["verified-clean"]);
  const body = publicProjectReport(saved);
  expect(body).toContain("### Vantage mandatory checks");
  expect(body).toContain(slots.slots["how-run"]);
  expect(body).not.toContain("keryx:report-slots");
});

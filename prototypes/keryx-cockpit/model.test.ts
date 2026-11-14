import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
const load = () => import("./model.js");
test("six scenarios are explicit demo data", async () => {
  const { scenarios } = await load();
  expect(Object.keys(scenarios)).toEqual(["working", "attention", "verified", "stale", "unbound", "offline"]);
  for (const s of Object.values(scenarios) as any[]) expect(s.demo).toBe(true);
});
test("working is not verified; plan progress is independent", async () => {
  const { scenarios, present } = await load();
  expect(present(scenarios.working).evidenceTone).not.toBe("success");
  expect(present(scenarios.working).completed).toBe(2);
  expect(present(scenarios.working).total).toBe(5);
});
test("attention navigates rather than approves", async () => {
  const { scenarios, present } = await load();
  expect(present(scenarios.attention).needsAttention).toBe(true);
  expect(present(scenarios.attention).action).toBe("terminal-preview");
});
test("stale evidence cannot be green", async () => {
  const { scenarios, present } = await load();
  expect(present(scenarios.stale).evidenceTone).toBe("warning");
  expect(present(scenarios.stale).sourceLabel).toContain("устарели");
});
test("unbound differs from offline; offline navigation is disabled", async () => {
  const { scenarios, present } = await load();
  expect(present(scenarios.unbound).flowLabel).toBe("Flow не привязан");
  expect(present(scenarios.offline).flowLabel).toBe("Источник недоступен");
  expect(present(scenarios.offline).canNavigate).toBe(false);
});
test("six distinct plan states", async () => {
  const { planStates } = await load();
  expect(Object.keys(planStates).sort()).toEqual(["blocked", "completed", "in_progress", "pending", "proposed", "skipped"]);
  expect(new Set(Object.values(planStates).map((s: any) => s.label)).size).toBe(6);
});
test("local responsive entry has explicit demo marker", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  for (const text of ['name="viewport"', "ДЕМО", 'src="model.js"']) expect(html).toContain(text);
  expect(html).not.toMatch(/https?:\/\//);
});

import { expect, test } from "bun:test";
import { isTreesitterEnabled, setTreesitterEnabled, TREESITTER_CAPABILITY } from "./symbols-capability";

test("enable adds the capability entry to an empty manifest", () => {
  const next = setTreesitterEnabled({}, true);
  expect(isTreesitterEnabled(next)).toBe(true);
  const caps = (next.modules as any).gdgraph.capabilities;
  expect(caps).toHaveLength(1);
  expect(caps[0]).toMatchObject({ id: TREESITTER_CAPABILITY, enabled: true, kind: "ceiling" });
});

test("disable flips enabled to false", () => {
  const enabled = setTreesitterEnabled({}, true);
  const disabled = setTreesitterEnabled(enabled, false);
  expect(isTreesitterEnabled(disabled)).toBe(false);
});

test("is idempotent — never duplicates the capability entry", () => {
  let m: Record<string, unknown> = {};
  m = setTreesitterEnabled(m, true);
  m = setTreesitterEnabled(m, true);
  const caps = (m.modules as any).gdgraph.capabilities.filter(
    (c: any) => c.id === TREESITTER_CAPABILITY,
  );
  expect(caps).toHaveLength(1);
});

test("preserves other gdgraph capabilities and other modules", () => {
  const manifest = {
    modules: {
      gdgraph: { enabled: true, capabilities: [{ id: "gdgraph.other", enabled: true }] },
      security: { enabled: true },
    },
    schemaVersion: 1,
  };
  const next = setTreesitterEnabled(manifest, true) as any;
  const ids = next.modules.gdgraph.capabilities.map((c: any) => c.id).sort();
  expect(ids).toEqual(["gdgraph.other", "gdgraph.treesitter"]);
  expect(next.modules.security).toEqual({ enabled: true });
  expect(next.schemaVersion).toBe(1);
});

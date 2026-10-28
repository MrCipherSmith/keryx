import { describe, expect, test } from "bun:test";
import type { GraphData } from "../gdgraph/types";
import { computeBlastRadius } from "./blast-radius";
import {
  buildDegradationConsumers,
  changedExportsOf,
  DEFAULT_DEGRADATION_CONSUMER_CAP,
  renderDegradationPayloadBrief,
  touchesSharedSymbol,
} from "./degradation-payload";

/** `from -> to` means `from` imports `to`, so the consumers of `to` are the `from`s. */
function graphOf(edges: ReadonlyArray<[string, string]>, extraNodes: readonly string[] = []): GraphData {
  const paths = new Set<string>(extraNodes);
  for (const [from, to] of edges) {
    paths.add(from);
    paths.add(to);
  }
  return {
    nodes: [...paths].sort().map((path) => ({ id: path, kind: "file" as const, path, language: "typescript" as const })),
    edges: edges.map(([from, to], index) => ({ id: `e${index}`, from, to, kind: "imports" as const, specifier: to })),
  };
}

const SHARED = "src/ui/field.ts";

function consumersOf(shared: string, count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, index): [string, string] => [`src/screens/screen-${String(index).padStart(2, "0")}.ts`, shared]);
}

describe("AC5: the consumers of a changed shared export come from the graph", () => {
  test("every direct importer of the changed module is a consumer, the changed module itself is not", () => {
    const graph = graphOf([...consumersOf(SHARED, 3), ["src/deep.ts", "src/screens/screen-00.ts"]]);
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: ["Field"] }] });

    expect(payload.consumers.map((consumer) => consumer.file)).toEqual([
      "src/screens/screen-00.ts",
      "src/screens/screen-01.ts",
      "src/screens/screen-02.ts",
    ]);
    expect(payload.consumers.every((consumer) => consumer.via === SHARED)).toBe(true);
    expect(payload.capped).toBe(false);
    expect(payload.dropped).toEqual([]);
    expect(payload.summary).toContain("dropped no consumer");
  });

  test("a consumer that is itself in the diff is not repeated", () => {
    const graph = graphOf(consumersOf(SHARED, 3));
    const payload = buildDegradationConsumers({
      graph,
      changedExports: [{ file: SHARED, names: "*" }],
      changedFiles: [SHARED, "src/screens/screen-01.ts"],
    });

    expect(payload.consumers.map((consumer) => consumer.file)).not.toContain("src/screens/screen-01.ts");
    expect(payload.total).toBe(2);
  });

  test("a capped set records the cap, lists what it dropped and the summary says so", () => {
    const graph = graphOf(consumersOf(SHARED, 7));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: ["Field"] }], cap: 5 });

    expect(payload.cap).toBe(5);
    expect(payload.consumers).toHaveLength(5);
    expect(payload.capped).toBe(true);
    expect(payload.dropped).toHaveLength(2);
    expect(payload.total).toBe(7);
    expect(payload.summary).toBe("the cap of 5 dropped 2 of 7 consumers; the dropped ones are listed and were NOT traced");

    const brief = renderDegradationPayloadBrief(payload);
    expect(brief).toContain("CAP: the cap of 5 dropped 2 of 7 consumers");
    expect(brief).toContain("NOT TRACED (2): src/screens/screen-05.ts, src/screens/screen-06.ts");
  });

  test("a set exactly at the cap drops nothing and says so", () => {
    const graph = graphOf(consumersOf(SHARED, 5));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }], cap: 5 });

    expect(payload.capped).toBe(false);
    expect(payload.summary).toContain("dropped no consumer (5 found)");
  });

  test("the default cap is recorded when none is given", () => {
    const graph = graphOf(consumersOf(SHARED, DEFAULT_DEGRADATION_CONSUMER_CAP + 3));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }] });

    expect(payload.cap).toBe(DEFAULT_DEGRADATION_CONSUMER_CAP);
    expect(payload.dropped).toHaveLength(3);
  });

  test("more imported consumers rank first, so the cap drops the least shared ones", () => {
    const graph = graphOf([
      ["src/quiet.ts", SHARED],
      ["src/hub.ts", SHARED],
      ["src/x.ts", "src/hub.ts"],
      ["src/y.ts", "src/hub.ts"],
    ]);
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }], cap: 1 });

    expect(payload.consumers.map((consumer) => consumer.file)).toEqual(["src/hub.ts"]);
    expect(payload.dropped.map((consumer) => consumer.file)).toEqual(["src/quiet.ts"]);
  });

  test("a changed module the graph has no node for is unresolved, not 'no consumers'", () => {
    const graph = graphOf(consumersOf(SHARED, 1));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: "docs/schema.json", names: "*" }] });

    expect(payload.consumers).toEqual([]);
    expect(payload.unresolved).toEqual(["docs/schema.json"]);
    expect(renderDegradationPayloadBrief(payload)).toContain("NOT ANSWERABLE (1): docs/schema.json");
  });

  test("two changed exports sharing a consumer list it once, via the first", () => {
    const other = "src/ui/label.ts";
    const graph = graphOf([
      ["src/screen.ts", SHARED],
      ["src/screen.ts", other],
    ]);
    const payload = buildDegradationConsumers({
      graph,
      changedExports: [
        { file: SHARED, names: ["Field"] },
        { file: other, names: ["Label"] },
      ],
    });

    expect(payload.consumers).toEqual([{ file: "src/screen.ts", via: SHARED, fanIn: 0 }]);
  });
});

describe("AC5/AC6: the changed exports come from the blast-radius record", () => {
  const graph = graphOf([...consumersOf(SHARED, 2), ["src/other.ts", "src/private.ts"]]);

  test("file mode: every changed graph node is a shared module with every export", () => {
    const radius = computeBlastRadius({ graph, changedFiles: [SHARED, "docs/readme.md"] });

    expect(changedExportsOf(radius)).toEqual([{ file: SHARED, names: "*" }]);
    expect(touchesSharedSymbol(changedExportsOf(radius))).toBe(true);
  });

  test("symbol mode: a seed with no changed export is not shared", () => {
    const radius = computeBlastRadius({ graph, changedFiles: [SHARED] });
    const symbolRecord = {
      ...radius,
      reach: {
        mode: "symbol" as const,
        seeds: [
          { file: SHARED, names: ["Field", "Adapter"], mode: "symbol" as const, detail: "" },
          { file: "src/private.ts", names: [], mode: "symbol" as const, detail: "" },
        ],
        barrels: [],
        textKeys: 0,
        textHubs: [],
        textSkipped: 0,
      },
    };

    expect(changedExportsOf(symbolRecord)).toEqual([{ file: SHARED, names: ["Adapter", "Field"] }]);
    expect(touchesSharedSymbol([])).toBe(false);
  });
});

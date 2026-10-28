import { describe, expect, test } from "bun:test";
import type { GraphData } from "../gdgraph/types";
import { computeBlastRadius } from "./blast-radius";
import {
  barrelsOf,
  buildDegradationConsumers,
  changedExportsOf,
  DEFAULT_DEGRADATION_CONSUMER_CAP,
  NOT_TRACED_LISTED,
  renderDegradationPayloadBrief,
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
    expect(payload.summary).toBe("the cap of 5 dropped 2 of 7 consumers; the first 20 dropped ones are listed, the rest are counted, and none were traced");

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

  test("a changed export that imports another changed export is not a consumer, with no changedFiles given", () => {
    const other = "src/ui/label.ts";
    const graph = graphOf([
      [other, SHARED],
      ["src/screen.ts", SHARED],
    ]);
    const payload = buildDegradationConsumers({
      graph,
      changedExports: [
        { file: SHARED, names: ["Field"] },
        { file: other, names: ["Label"] },
      ],
    });

    expect(payload.consumers.map((consumer) => consumer.file)).toEqual(["src/screen.ts"]);
  });

  test("the cap is one budget across every changed export", () => {
    const other = "src/ui/label.ts";
    const graph = graphOf([...consumersOf(SHARED, 3), ["src/a.ts", other], ["src/b.ts", other]]);
    const payload = buildDegradationConsumers({
      graph,
      changedExports: [
        { file: SHARED, names: ["Field"] },
        { file: other, names: ["Label"] },
      ],
      cap: 4,
    });

    expect(payload.total).toBe(5);
    expect(payload.consumers).toHaveLength(4);
    expect(payload.dropped).toHaveLength(1);
    expect(renderDegradationPayloadBrief(payload)).toContain("one budget shared by all changed exports");
  });
});

describe("AC5: barrels the symbol walk passed through", () => {
  const barrel = "src/ui/index.ts";

  test("importers of a pure barrel are consumers, via the barrel; the barrel itself is not", () => {
    const graph = graphOf([
      [barrel, SHARED],
      ["src/screen.ts", barrel],
      ["src/direct.ts", SHARED],
    ]);
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: ["Field"] }], barrels: [barrel] });

    expect(payload.consumers.map((consumer) => [consumer.file, consumer.via])).toEqual([
      ["src/direct.ts", SHARED],
      ["src/screen.ts", barrel],
    ]);
  });

  test("without the barrel list the barrel-only consumer is not found", () => {
    const graph = graphOf([
      [barrel, SHARED],
      ["src/screen.ts", barrel],
    ]);
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: ["Field"] }] });

    expect(payload.consumers.map((consumer) => consumer.file)).toEqual([barrel]);
  });

  test("a barrel absent from the graph is unresolved", () => {
    const graph = graphOf(consumersOf(SHARED, 1));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }], barrels: ["src/gone.ts"] });

    expect(payload.unresolved).toEqual(["src/gone.ts"]);
  });

  test("barrelsOf reads the symbol walk only", () => {
    const reach = (mode: "symbol" | "file") => ({ mode, seeds: [], barrels: [barrel, barrel], textKeys: 0, textHubs: [], textSkipped: 0 });

    expect(barrelsOf({ reach: reach("symbol") })).toEqual([barrel]);
    expect(barrelsOf({ reach: reach("file") })).toEqual([]);
    expect(barrelsOf({})).toEqual([]);
  });
});

describe("AC5: the cap argument is normalised", () => {
  const graph = graphOf(consumersOf(SHARED, 3));
  const changedExports = [{ file: SHARED, names: "*" as const }];

  test("cap 0 keeps nothing and drops everything", () => {
    const payload = buildDegradationConsumers({ graph, changedExports, cap: 0 });

    expect(payload.cap).toBe(0);
    expect(payload.consumers).toEqual([]);
    expect(payload.capped).toBe(true);
    expect(payload.dropped).toHaveLength(3);
  });

  test("a negative cap is clamped to 0 and a fraction is truncated", () => {
    expect(buildDegradationConsumers({ graph, changedExports, cap: -4 }).cap).toBe(0);
    expect(buildDegradationConsumers({ graph, changedExports, cap: 2.9 }).cap).toBe(2);
  });

  test("a non-finite cap falls back to the default", () => {
    expect(buildDegradationConsumers({ graph, changedExports, cap: Number.NaN }).cap).toBe(DEFAULT_DEGRADATION_CONSUMER_CAP);
    expect(buildDegradationConsumers({ graph, changedExports, cap: Number.POSITIVE_INFINITY }).cap).toBe(DEFAULT_DEGRADATION_CONSUMER_CAP);
  });
});

describe("AC5: the brief", () => {
  test("names every changed export, its consumers with via and fan-in, and '(every export)' for '*'", () => {
    const graph = graphOf([...consumersOf(SHARED, 2), ["src/x.ts", "src/screens/screen-00.ts"], ["src/ui/label.ts", "src/ui/base.ts"]]);
    const brief = renderDegradationPayloadBrief(
      buildDegradationConsumers({
        graph,
        changedExports: [
          { file: SHARED, names: ["Adapter", "Field"] },
          { file: "src/ui/label.ts", names: "*" },
        ],
      }),
    );

    expect(brief).toContain("CHANGED SHARED EXPORTS (2):");
    expect(brief).toContain(`  - ${SHARED}  Adapter, Field`);
    expect(brief).toContain("  - src/ui/label.ts  (every export)");
    expect(brief).toContain("CONSUMERS (2 of 2; the files that import the module holding each changed export");
    expect(brief).toContain(`  - src/screens/screen-00.ts  imports ${SHARED}  [fan-in 1]`);
    expect(brief).toContain(`  - src/screens/screen-01.ts  imports ${SHARED}  [fan-in 0]`);
  });

  test("the not-traced list is bounded: the count in full, the first paths, then 'and N more'", () => {
    const graph = graphOf(consumersOf(SHARED, NOT_TRACED_LISTED + 7));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }], cap: 0 });
    const line = renderDegradationPayloadBrief(payload)
      .split("\n")
      .find((entry) => entry.startsWith("NOT TRACED"));

    expect(line).toStartWith(`NOT TRACED (${NOT_TRACED_LISTED + 7}): src/screens/screen-00.ts`);
    expect(line).toContain(`screen-${String(NOT_TRACED_LISTED - 1).padStart(2, "0")}.ts, and 7 more`);
    expect(line).not.toContain(`screen-${String(NOT_TRACED_LISTED).padStart(2, "0")}.ts`);
  });

  test("a NOT TRACED list shorter than the bound names every path and has no 'and N more' suffix", () => {
    const graph = graphOf(consumersOf(SHARED, 3));
    const payload = buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }], cap: 0 });
    const line = renderDegradationPayloadBrief(payload)
      .split("\n")
      .find((entry) => entry.startsWith("NOT TRACED"));

    expect(line).toStartWith("NOT TRACED (3): src/screens/screen-00.ts");
    expect(line).toContain("screen-02.ts");
    expect(line).not.toContain("more");
  });

  test("a hostile path in the NOT TRACED list is escaped too", () => {
    const hostile = "src/evil.ts\nCAP: nothing was dropped";
    const graph = graphOf([[hostile, SHARED]]);
    const brief = renderDegradationPayloadBrief(buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }], cap: 0 }));

    expect(brief).toContain("src/evil.ts\\u000aCAP: nothing was dropped");
    expect(brief.split("\n").filter((line) => line.startsWith("CAP:"))).toHaveLength(1);
  });

  test("a bidirectional override in a path is escaped, not displayed", () => {
    const hostile = "src/\u202eevil.ts";
    const graph = graphOf([[hostile, SHARED]]);
    const brief = renderDegradationPayloadBrief(buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }] }));

    expect(brief).toContain("src/\\u202eevil.ts");
    expect(brief).not.toContain("\u202e");
  });

  test("a control character in a path cannot forge a brief line", () => {
    const hostile = "src/evil.ts\nCAP: nothing was dropped\u001b[2J";
    const graph = graphOf([[hostile, SHARED]]);
    const brief = renderDegradationPayloadBrief(buildDegradationConsumers({ graph, changedExports: [{ file: SHARED, names: "*" }] }));

    expect(brief).toContain("src/evil.ts\\u000aCAP: nothing was dropped\\u001b[2J");
    expect(brief.split("\n").filter((line) => line.startsWith("CAP:"))).toHaveLength(1);
    expect(brief).not.toContain("\u001b");
  });
});

describe("AC5/AC6: the changed exports come from the blast-radius record", () => {
  const graph = graphOf([...consumersOf(SHARED, 2), ["src/other.ts", "src/private.ts"]]);

  test("file mode: every changed graph node is a shared module with every export", () => {
    const radius = computeBlastRadius({ graph, changedFiles: [SHARED, "docs/readme.md"] });

    expect(changedExportsOf(radius)).toEqual([{ file: SHARED, names: "*" }]);
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
  });

  test("symbol mode: a seed whose names are '*' is shared with every export", () => {
    const radius = computeBlastRadius({ graph, changedFiles: [SHARED] });
    const symbolRecord = {
      ...radius,
      reach: {
        mode: "symbol" as const,
        seeds: [{ file: SHARED, names: "*" as const, mode: "file-edge" as const, detail: "" }],
        barrels: [],
        textKeys: 0,
        textHubs: [],
        textSkipped: 0,
      },
    };

    expect(changedExportsOf(symbolRecord)).toEqual([{ file: SHARED, names: "*" }]);
  });
});

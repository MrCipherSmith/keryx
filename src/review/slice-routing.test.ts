import { describe, expect, test } from "bun:test";
import type { BuiltSlice } from "./slice";
import { overlapGroupsOf, collectReviewers } from "./reviewers";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  ALWAYS_ROLE,
  AUDIT_RATE,
  DEEP_ROLES,
  auditCount,
  auditSample,
  BUNDLED_OVERLAP_GROUPS,
  collapseOverlapGroups,
  contentRolesOf,
  deepRosterRoles,
  escalateSlice,
  routeSlices,
  summarizeRouting,
} from "./slice-routing";

/** One slice per file, in the scoped form `buildSlices` writes. */
function sliced(files: ReadonlyArray<readonly [string, readonly string[]]>): BuiltSlice[] {
  return files.map(([file, lines], index) => {
    const id = `slice-${String(index + 1).padStart(2, "0")}`;
    const text = `--- ${file}\n@@ 1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
    return { id, path: `${id}.diff`, bytes: text.length, files: [file], domain: file.split("/")[0]!, split: "domain", text };
  });
}

const rolesOf = (slices: ReturnType<typeof routeSlices>, file: string): string[] => slices.find((slice) => slice.files.includes(file))!.roles!;

describe("roles come from the slice's content", () => {
  const slices = routeSlices(
    sliced([
      ["web/Button.module.css", [".button { padding: 4px; margin: 0; }"]],
      ["pkg/util.test.ts", ["import { add } from './util';", "test('adds', () => expect(add(1, 2)).toBe(3));"]],
      ["svc/runner.ts", ["export async function run(cmd: string) {", "  return Bun.spawn(['sh', '-c', cmd]);", "}"]],
      ["guide/intro.md", ["# Intro", "Some prose."]],
      ["lib/math.ts", ["const x = 1;"]],
      ["app/Panel.tsx", ["export function Panel() { return <div className=\"p\" style={{ width: 2 }} />; }"]],
    ]),
    { head: "abc", auditRate: 0 },
  );

  test("review-logic is on every slice and every slice has at least one role", () => {
    for (const slice of slices) {
      expect(slice.roles).toContain(ALWAYS_ROLE);
      expect(slice.roles!.length).toBeGreaterThan(0);
    }
  });

  test("styles go to the styling and layout roles, tests to testing-practices, docs to style", () => {
    expect(rolesOf(slices, "web/Button.module.css")).toEqual(expect.arrayContaining(["review-layout", "review-style", "review-frontend"]));
    expect(rolesOf(slices, "pkg/util.test.ts")).toContain("review-testing-practices");
    expect(rolesOf(slices, "pkg/util.test.ts")).not.toContain("review-security-code");
    expect(rolesOf(slices, "guide/intro.md")).toEqual(["review-logic", "review-style"]);
    expect(rolesOf(slices, "app/Panel.tsx")).toEqual(expect.arrayContaining(["review-frontend", "review-layout", "review-architecture"]));
  });

  test("a process spawn routes the security reviewer; a deep plain-code slice gets every roster role its gates allow", () => {
    expect(rolesOf(slices, "svc/runner.ts")).toEqual(expect.arrayContaining(["review-security-code", "review-architecture", "review-clean-code"]));
    // Owner decision 2026-10-16: deep = the old plan's full set for the slice (style, clean-code, performance, highload, ...)
    // minus the roles whose path gate rules the file out (testing-practices, layout, core-boundaries, flow-graph here).
    const math = rolesOf(slices, "lib/math.ts");
    // Flow 458 AC6: the frontend overlap group collapses to one member per slice.
    expect(math).toEqual(collapseOverlapGroups(new Set([ALWAYS_ROLE, ...DEEP_ROLES, ...deepRosterRoles(["lib/math.ts"])])).sort());
    expect(math).toEqual(expect.arrayContaining(["review-style", "review-clean-code", "review-performance", "review-highload"]));
    for (const gated of ["review-testing-practices", "review-layout", "review-core-boundaries", "review-flow-graph"]) expect(math).not.toContain(gated);
    expect(deepRosterRoles(["src/core/a.test.ts"])).toEqual(expect.arrayContaining(["review-testing-practices", "review-core-boundaries"]));
  });

  test("content roles carry the reason they were chosen", () => {
    expect(contentRolesOf({ path: "pkg/util.test.ts", text: "+test('x', () => {})" })).toEqual([{ role: "review-testing-practices", why: "test file: pkg/util.test.ts" }]);
  });
});

describe("review-degradation routing (flow 479 AC6)", () => {
  const exported = "+export function render(value: string) { return value; }";

  test("a changed exported symbol routes the degradation reviewer, with the reason", () => {
    const hits = contentRolesOf({ path: "src/ui/field.ts", text: exported });
    expect(hits).toContainEqual({ role: "review-degradation", why: "shared (exported) symbol changed: src/ui/field.ts" });
  });

  test("a removed export counts as much as an added one, and a re-export or a default export counts", () => {
    for (const line of ["-export const DEFAULT_LABEL = 'n/a';", "+export * from './field';", "+export { Field } from './field';", "+export default function Field() {}", "+export type Label = string;"]) {
      expect(contentRolesOf({ path: "src/ui/field.ts", text: line }).map((hit) => hit.role)).toContain("review-degradation");
    }
  });

  test("every declaration form of the exported-symbol pattern routes it (flow 479 TP-005)", () => {
    const forms = [
      "+export declare const VERSION: string;",
      "+export declare function parse(input: string): number;",
      "+export abstract class Base {}",
      "+export enum Level { Low, High }",
      "+export let counter = 0;",
      "-export var legacy = 1;",
      "+export async function load() {}",
      "+export interface Shape { size: number }",
      "+export class Field {}",
      "-export default class Field {}",
    ];
    for (const line of forms) expect(contentRolesOf({ path: "src/ui/field.ts", text: line }).map((hit) => hit.role)).toContain("review-degradation");
  });

  test("an `export` inside a comment, a string or an unchanged line is not a changed declaration (flow 479 TP-005)", () => {
    const lines = ["+// export const LABEL = 'n/a';", "+const doc = \"export const LABEL = 1\";", "+  * export function render() {}", " export const LABEL = 'n/a';", "+exports.LABEL = 1;"];
    for (const line of lines) expect(contentRolesOf({ path: "src/ui/field.ts", text: line }).map((hit) => hit.role)).not.toContain("review-degradation");
  });

  test("a change that touches no shared symbol does not route it", () => {
    for (const text of ["+  return total + 1;", "+const local = 1;", "+function helper() { return 1; }", " export const untouched = 1;"]) {
      expect(contentRolesOf({ path: "src/ui/field.ts", text }).map((hit) => hit.role)).not.toContain("review-degradation");
    }
  });

  test("an export in a test, a doc or a non-code file is not a shared symbol", () => {
    for (const file of ["src/ui/field.test.ts", "docs/guide.md", "data/export.json"]) {
      expect(contentRolesOf({ path: file, text: exported }).map((hit) => hit.role)).not.toContain("review-degradation");
    }
  });

  test("it is a routable role, so a deep slice's roster carries it", () => {
    expect(deepRosterRoles(["src/ui/field.ts"])).toContain("review-degradation");
    const [slice] = routeSlices(sliced([["src/ui/field.ts", ["export const LABEL = 'n/a';"]]]), { head: "h", auditRate: 0 });
    expect(slice!.roles).toContain("review-degradation");
  });
});

describe("depth follows risk", () => {
  test("a deterministic risk class (auth path) sends the slice deep with the full core set", () => {
    const [slice] = routeSlices(sliced([["src/auth/login.ts", ["const retries = 3;"]]]), { head: "h", auditRate: 0 });
    expect(slice!.depth).toBe("deep");
    expect(slice!.roles).toEqual(expect.arrayContaining([...DEEP_ROLES]));
    expect(slice!.risk!.why.join(" ")).toContain("auth/permissions");
    expect(slice!.risk!.score).toBeGreaterThanOrEqual(0.9);
  });

  test("a light slice (config, data) gets only its content roles", () => {
    const [slice] = routeSlices(sliced([["data/table.csv", ["a,b"]]]), { head: "h", auditRate: 0 });
    expect(slice!.depth).toBe("light");
    expect(slice!.roles).toEqual(["review-logic"]);
    expect(slice!.audit).toBeUndefined();
    expect(slice!.risk!.why.join(" ")).toContain("docs, tests, config or generated");
  });

  test("any non-test source code goes deep, whatever the risk score", () => {
    for (const file of ["lib/math.ts", "tools/run.py", "cmd/main.go", "scripts/build.sh", "db/q.sql", "src/lib/trust-routine-command.ts"]) {
      const [slice] = routeSlices(sliced([[file, ["const x = 1;"]]]), { head: "h", auditRate: 0 });
      expect(slice!.depth).toBe("deep");
      expect(slice!.roles).toEqual(expect.arrayContaining([...DEEP_ROLES]));
      expect(slice!.risk!.why.join(" ")).toContain("source code");
    }
  });

  test("agent instructions and contracts go deep, with the reason", () => {
    for (const file of ["skills/review/SKILL.md", "skills/review/SKILL.detail.md", ".metaproject/rules/core/x.mdc", "AGENTS.md", "CLAUDE.md", "prompts/plan.md"]) {
      const [slice] = routeSlices(sliced([[file, ["Do the thing."]]]), { head: "h", auditRate: 0 });
      expect(slice!.depth).toBe("deep");
      expect(slice!.risk!.why.join(" ")).toContain("agent instructions");
    }
    const [schema] = routeSlices(sliced([["schemas/plan.schema.json", ["{}"]]]), { head: "h", auditRate: 0 });
    expect(schema!.depth).toBe("deep");
    expect(schema!.risk!.why.join(" ")).toContain("schema");
  });

  test("docs, tests, fixtures, config, lock and generated files stay light", () => {
    for (const file of ["docs/guide.md", "README.md", "notes.txt", "src/a.test.ts", "src/__tests__/helper.ts", "test/fixtures/sample.ts", "src/__snapshots__/a.snap", "package.json", "ci.yaml", "bun.lock", "dist/bundle.js", "src/api.generated.ts"]) {
      const [slice] = routeSlices(sliced([[file, ["x"]]]), { head: "h", auditRate: 0 });
      expect(`${file}:${slice!.depth}`).toBe(`${file}:light`);
    }
  });

  test("a mixed slice with one code file is deep", () => {
    const [slice] = routeSlices(sliced([["docs/a.md", ["x"]]]).map((s) => ({ ...s, text: `${s.text}\n--- lib/b.ts
@@ 1,1 @@
+const y = 1;
`, files: ["docs/a.md", "lib/b.ts"] })), { head: "h", auditRate: 0 });
    expect(slice!.depth).toBe("deep");
  });

  test("reach over the threshold sends a slice deep; at the threshold it stays light", () => {
    const files = sliced([["data/hub.csv", ["a,b"]]]);
    expect(routeSlices(files, { head: "h", auditRate: 0, reach: { "data/hub.csv": 26 }, reachThreshold: 25 })[0]!.depth).toBe("deep");
    expect(routeSlices(files, { head: "h", auditRate: 0, reach: { "data/hub.csv": 25 }, reachThreshold: 25 })[0]!.depth).toBe("light");
  });

  test("a Jev score >= 0.7 for the slice or its file sends it deep", () => {
    const files = sliced([["data/hub.csv", ["a,b"]]]);
    expect(routeSlices(files, { head: "h", auditRate: 0, jevScores: { "data/hub.csv": 0.7 } })[0]!.depth).toBe("deep");
    expect(routeSlices(files, { head: "h", auditRate: 0, jevScores: { [files[0]!.id]: 0.69 } })[0]!.depth).toBe("light");
  });
});

describe("audit sample", () => {
  const ids = Array.from({ length: 80 }, (_, i) => `slice-${String(i + 1).padStart(2, "0")}`);

  test("10-15% of light slices, the same picks for the same head", () => {
    const picks = auditSample("head-a", ids);
    expect(picks.size / ids.length).toBeGreaterThanOrEqual(0.1);
    expect(picks.size / ids.length).toBeLessThanOrEqual(0.15);
    expect([...auditSample("head-a", ids)]).toEqual([...picks]);
    expect([...auditSample("head-b", ids)].sort()).not.toEqual([...picks].sort());
    expect(AUDIT_RATE).toBeGreaterThanOrEqual(0.1);
  });

  test("the count rule: none below 4 light slices, at least one from 4, otherwise ceil(n x rate) inside [10%, 15%]", () => {
    expect([0, 1, 2, 3].map((n) => auditCount(n))).toEqual([0, 0, 0, 0]);
    expect([4, 5, 6, 7].map((n) => auditCount(n))).toEqual([1, 1, 1, 1]);
    for (let n = 7; n <= 200; n += 1) {
      const count = auditCount(n);
      const low = Math.ceil(n * 0.1);
      const high = Math.floor(n * 0.15);
      // Where no whole count lies in the band (n = 11-13) the 15% cap wins.
      expect({ n, count }).toEqual({ n, count: low <= high ? Math.min(high, Math.max(low, Math.ceil(n * AUDIT_RATE))) : high });
    }
    // round() gave 2 of 12 (16.7%), over the 15% cap; the clamp gives 1 there and keeps every count from 14 up inside 10-15%.
    expect(auditCount(12)).toBe(1);
    expect(auditCount(14)).toBe(2);
    expect(auditCount(20)).toBe(3);
    expect(auditCount(100, 0.5)).toBe(15);
    // A rate of 0 turns the sample off (plan-eval measures routing alone with it).
    expect(auditCount(100, 0)).toBe(0);
    expect(auditCount(100, 0.01)).toBe(10);
  });

  test("audited slices run deep, marked audit, and the summary counts them", () => {
    const files = Array.from({ length: 16 }, (_, i) => [`m${i}/plain.csv`, [`v${i},${i}`]] as const);
    const slices = routeSlices(sliced(files), { head: "seed" });
    const audited = slices.filter((slice) => slice.audit === true);
    expect(audited.length).toBe(auditCount(16));
    for (const slice of audited) {
      expect(slice.depth).toBe("deep");
      expect(slice.roles).toEqual(expect.arrayContaining([...DEEP_ROLES]));
    }
    expect(summarizeRouting(slices)).toMatchObject({ slices: 16, deep: audited.length, audit: audited.length, light: 16 - audited.length });
  });
});

test("escalation re-opens a light slice deep with every core role, and leaves a deep one alone", () => {
  const light = { id: "s1", path: "s1.diff", bytes: 1, files: ["a.ts"], domain: "d", split: "domain" as const, roles: ["review-logic"], depth: "light" as const };
  const up = escalateSlice(light, "review-logic", "F-1");
  expect(up.depth).toBe("deep");
  expect(up.roles).toEqual(expect.arrayContaining([...DEEP_ROLES]));
  expect(up.escalated).toEqual({ by: "review-logic", finding: "F-1" });
  expect(escalateSlice(up, "x", "y")).toBe(up);
});

describe("overlap groups (flow 458 AC6)", () => {
  test("each overlap group gets one role per slice: the first-ranked member the slice routes", () => {
    const slices = routeSlices(
      sliced([
        ["app/Panel.tsx", ["export function Panel() { return <div className=\"p\" />; }"]],
        ["lib/math.ts", ["const x = 1;"]],
      ]),
      { head: "abc", auditRate: 0 },
    );
    for (const slice of slices) {
      const members = (slice.roles ?? []).filter((role) => BUNDLED_OVERLAP_GROUPS.frontend!.includes(role));
      expect(members).toEqual(["review-frontend"]);
    }
  });

  test("a caller's groups replace the bundled default; an empty set collapses nothing", () => {
    const [slice] = routeSlices(sliced([["app/Panel.tsx", ["const a = 1;"]]]), { head: "h", auditRate: 0, overlapGroups: {} });
    expect(slice!.roles).toEqual(expect.arrayContaining(["review-frontend", "review-frontend-conventions"]));
    expect(collapseOverlapGroups(["a", "b", "c"], { g: ["b", "a"] }).sort()).toEqual(["b", "c"]);
    expect(collapseOverlapGroups(["c"], { g: ["b", "a"] })).toEqual(["c"]);
  });

  test("the bundled default is the one the reviewers' frontmatter declares", async () => {
    // An empty project: the inventory falls back to the package's own bundled review skills.
    const root = await mkdtemp(path.join(tmpdir(), "gd-overlap-"));
    try {
      const inventory = await collectReviewers(root);
      expect(inventory.bundledSource).toBe("package");
      expect(overlapGroupsOf(inventory)).toEqual(Object.fromEntries(Object.entries(BUNDLED_OVERLAP_GROUPS).map(([k, v]) => [k, [...v]])));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

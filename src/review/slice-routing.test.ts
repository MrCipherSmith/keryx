import { describe, expect, test } from "bun:test";
import type { BuiltSlice } from "./slice";
import {
  ALWAYS_ROLE,
  AUDIT_RATE,
  DEEP_ROLES,
  auditSample,
  contentRolesOf,
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

  test("a process spawn routes the security reviewer; a plain constant gets review-logic alone", () => {
    expect(rolesOf(slices, "svc/runner.ts")).toEqual(expect.arrayContaining(["review-security-code", "review-architecture", "review-clean-code"]));
    expect(rolesOf(slices, "lib/math.ts")).toEqual(["review-logic"]);
  });

  test("content roles carry the reason they were chosen", () => {
    expect(contentRolesOf({ path: "pkg/util.test.ts", text: "+test('x', () => {})" })).toEqual([{ role: "review-testing-practices", why: "test file: pkg/util.test.ts" }]);
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

  test("a light slice gets only its content roles", () => {
    const [slice] = routeSlices(sliced([["lib/math.ts", ["const x = 1;"]]]), { head: "h", auditRate: 0 });
    expect(slice!.depth).toBe("light");
    expect(slice!.roles).toEqual(["review-logic"]);
    expect(slice!.audit).toBeUndefined();
  });

  test("reach over the threshold sends a slice deep; at the threshold it stays light", () => {
    const files = sliced([["lib/hub.ts", ["const x = 1;"]]]);
    expect(routeSlices(files, { head: "h", auditRate: 0, reach: { "lib/hub.ts": 26 }, reachThreshold: 25 })[0]!.depth).toBe("deep");
    expect(routeSlices(files, { head: "h", auditRate: 0, reach: { "lib/hub.ts": 25 }, reachThreshold: 25 })[0]!.depth).toBe("light");
  });

  test("a Jev score >= 0.7 for the slice or its file sends it deep", () => {
    const files = sliced([["lib/hub.ts", ["const x = 1;"]]]);
    expect(routeSlices(files, { head: "h", auditRate: 0, jevScores: { "lib/hub.ts": 0.7 } })[0]!.depth).toBe("deep");
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

  test("audited slices run deep, marked audit, and the summary counts them", () => {
    const files = Array.from({ length: 16 }, (_, i) => [`m${i}/plain.ts`, [`const v${i} = ${i};`]] as const);
    const slices = routeSlices(sliced(files), { head: "seed" });
    const audited = slices.filter((slice) => slice.audit === true);
    expect(audited.length).toBe(Math.round(16 * AUDIT_RATE));
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

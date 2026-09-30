// Acceptance layer W0, AC2 — a second `[verify: …]` marker on one line, an
// `exec` or `invariant` marker without a backticked command, and a bare `none`
// without a reason are each a parse error that names the offending criterion id
// and exits non-zero. A malformed marker reads `unclassified`; it never reads as
// a kind the author did not manage to write.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand } from "../commands/flow";
import { parseAcKinds, stripVerifyMarker } from "./ac-kinds";
import { createFlowService } from "./service";
import type { FlowServiceDeps } from "./types";

function body(...lines: string[]): string {
  return ["# Acceptance Criteria", "", "## Criteria", "", ...lines, ""].join("\n");
}

function errorsFor(line: string): { id: string; message: string }[] {
  return [...parseAcKinds(body(line)).errors];
}

describe("malformed markers are parse errors naming the criterion", () => {
  test("a second marker on one line", () => {
    const errors = errorsFor("- AC7: Two markers [verify: judged] [verify: exec `bun test x`]");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("AC7");
    expect(errors[0]?.message).toContain("second");
  });

  test("anything after the marker, even a code span or a bracket, makes it not the last thing on the line", () => {
    for (const line of [
      "- AC1: see `a` [verify: judged] `b`",
      "- AC1: x [verify: exec `bun test x`] `keep.ts`",
      "- AC1: x [verify: judged] and [1]",
    ]) {
      expect(errorsFor(line)).toHaveLength(1);
    }
    for (const text of ["see `a` [verify: judged] `b`", "x [verify: exec `bun test x`] `keep.ts`"]) {
      expect(stripVerifyMarker(text)).toBe(text);
    }
    expect(stripVerifyMarker("x [verify: judged]")).toBe("x");
  });

  test("exec without a backticked command", () => {
    for (const marker of ["[verify: exec]", "[verify: exec bun test x]", "[verify: exec ``]"]) {
      const errors = errorsFor(`- AC3: No command ${marker}`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.id).toBe("AC3");
      expect(errors[0]?.message).toContain("exec");
    }
  });

  test("invariant without a backticked command", () => {
    const errors = errorsFor("- AC4: No command [verify: invariant]");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("AC4");
    expect(errors[0]?.message).toContain("invariant");
  });

  test("a bare none without a reason", () => {
    for (const marker of ["[verify: none]", "[verify: none —]", "[verify: none reason without a dash]"]) {
      const errors = errorsFor(`- AC9: Nothing to say ${marker}`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.id).toBe("AC9");
      expect(errors[0]?.message).toContain("none");
    }
  });

  test("other malformed shapes: unknown kind, empty marker, judged with arguments, marker not last", () => {
    expect(errorsFor("- AC1: x [verify: sometimes]")[0]?.message).toContain("unknown verification kind");
    expect(errorsFor("- AC1: x [verify: ]")[0]?.message).toContain("empty");
    expect(errorsFor("- AC1: x [verify: judged by a human]")[0]?.message).toContain("judged");
    expect(errorsFor("- AC1: x [verify: judged] and then more text")[0]?.message).toContain("last thing");
  });

  test("a malformed criterion reads unclassified and the others still parse", () => {
    const parsed = parseAcKinds(
      body("- AC1: ok [verify: judged]", "- AC2: broken [verify: exec]", "- AC3: also ok [verify: none — because]"),
    );
    expect(parsed.errors.map((e) => e.id)).toEqual(["AC2"]);
    const kinds = parsed.criteria.map((c) => c.record.kind);
    expect(kinds).toEqual(["judged", "unclassified", "none"]);
  });

  test("a well-formed line produces no error", () => {
    expect(errorsFor("- AC1: fine [verify: exec `bun test x`]")).toEqual([]);
    expect(errorsFor("- AC1: unmarked")).toEqual([]);
  });
});

describe("keryx flow ac kinds exits non-zero on a malformed marker", () => {
  let root = "";
  const cwd = process.cwd();
  const realLog = console.log;
  const realError = console.error;

  afterEach(async () => {
    console.log = realLog;
    console.error = realError;
    process.chdir(cwd);
    process.exitCode = 0;
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("names AC2, exits 1, and the freeze that preceded it still went through", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-ac-kinds-errors-"));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const deps: FlowServiceDeps = {
      tracker: null,
      healthGate: async () => ({ status: "pass", reasons: [] }),
      now: () => new Date("2026-09-28T10:00:00Z"),
    };
    const service = createFlowService(deps);
    const { flow, dir } = await service.init({ cwd: root, title: "Malformed marker" });
    await Bun.write(
      path.join(root, ".metaproject", "flows", path.basename(dir), "acceptance-criteria.md"),
      body("- AC1: fine [verify: judged]", "- AC2: broken [verify: exec]"),
    );
    // Freeze never refuses on a kind, malformed or not.
    const frozen = await service.freeze({ cwd: root, id: flow.id });
    expect(frozen.status).toBe("ready");
    expect(frozen.acKinds?.["AC2"]).toEqual({ kind: "unclassified" });

    process.chdir(root);
    const errs: string[] = [];
    console.log = () => {};
    console.error = (...args: unknown[]) => void errs.push(args.map(String).join(" "));
    await flowCommand(["ac", "kinds", flow.id]);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("AC2");
  });
});

// Flow 286 T6: trigger config loader tests. AC1: "each entry names what
// fires it ... and what it does; an entry that is malformed is refused on
// load with the reason, and the other entries still work."

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTriggersConfig, triggerEntryProblems, triggersConfigPath } from "./config";

async function projectWith(content: string | undefined): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-triggers-config-"));
  if (content !== undefined) {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(triggersConfigPath(root), content, "utf8");
  }
  return root;
}

describe("triggersConfigPath", () => {
  test("resolves under .metaproject/triggers.json", () => {
    expect(triggersConfigPath("/repo")).toBe(path.join("/repo", ".metaproject", "triggers.json"));
  });
});

describe("loadTriggersConfig: no file", () => {
  test("a project with no triggers.json loads zero triggers with fileProblem 'absent', not a throw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-triggers-config-"));
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBe("absent");
  });
});

describe("loadTriggersConfig: a valid file with several entries", () => {
  test("every entry loads: an event trigger, a schedule trigger, open-flow and flow-next actions", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "post-merge-reconcile", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
          {
            name: "nightly-rebuild",
            on: { kind: "schedule", cron: "0 2 * * *" },
            action: { kind: "rebuild" },
          },
          {
            name: "open-bugfix-flow",
            on: { kind: "event", event: "ci" },
            action: { kind: "open-flow", template: "bugfix", skipIfOpen: true },
          },
          {
            name: "advance-flow-286",
            on: { kind: "event", event: "post-commit" },
            action: { kind: "flow-next", flow: "286" },
          },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBeUndefined();
    expect(result.rejected).toEqual([]);
    expect(result.triggers).toHaveLength(4);

    const byName = Object.fromEntries(result.triggers.map((t) => [t.name, t]));
    expect(byName["post-merge-reconcile"]?.fire).toEqual({ kind: "event", event: "post-merge" });
    expect(byName["post-merge-reconcile"]?.action).toEqual({ kind: "reconcile" });
    expect(byName["post-merge-reconcile"]?.enabled).toBe(true);

    expect(byName["nightly-rebuild"]?.fire).toEqual({ kind: "schedule", cron: "0 2 * * *" });
    expect(byName["nightly-rebuild"]?.action).toEqual({ kind: "rebuild" });

    expect(byName["open-bugfix-flow"]?.fire).toEqual({ kind: "event", event: "ci" });
    expect(byName["open-bugfix-flow"]?.action).toEqual({ kind: "open-flow", template: "bugfix", skipIfOpen: true });

    expect(byName["advance-flow-286"]?.action).toEqual({ kind: "flow-next", flow: "286" });
  });

  test("enabled: false is preserved rather than defaulted to true", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          {
            name: "paused",
            on: { kind: "event", event: "post-merge" },
            action: { kind: "reconcile" },
            enabled: false,
          },
        ],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.triggers[0]?.enabled).toBe(false);
  });
});

describe("loadTriggersConfig: one malformed entry, neighbours survive", () => {
  test("a structurally broken middle entry is rejected with a reason; the entries before and after it still load", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "good-one", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
          { name: "broken", on: { kind: "event", event: "post-merge" } /* no action */ },
          { name: "good-two", on: { kind: "event", event: "post-checkout" }, action: { kind: "rebuild" } },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBeUndefined();
    expect(result.triggers.map((t) => t.name)).toEqual(["good-one", "good-two"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.name).toBe("broken");
    expect(result.rejected[0]?.reasons.some((r) => r.includes("action"))).toBe(true);
  });

  test("a duplicate name is rejected on the later entry; the first occurrence still loads", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "dupe", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
          { name: "dupe", on: { kind: "event", event: "post-checkout" }, action: { kind: "rebuild" } },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0]?.fire).toEqual({ kind: "event", event: "post-merge" });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reasons[0]).toContain("already used");
  });
});

describe("loadTriggersConfig: unknown event name", () => {
  test("an entry naming an event outside the known set is refused with the reason, others still load", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          { name: "unknown-event", on: { kind: "event", event: "pre-push" }, action: { kind: "reconcile" } },
          { name: "fine", on: { kind: "event", event: "post-merge" }, action: { kind: "reconcile" } },
        ],
      }),
    );

    const result = loadTriggersConfig(root);
    expect(result.triggers.map((t) => t.name)).toEqual(["fine"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe("unknown-event");
    expect(result.rejected[0]?.reasons.join(" ")).toContain("unknown event");
  });
});

describe("loadTriggersConfig: a schedule entry", () => {
  test("a well-formed cron shape loads as a schedule trigger", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "hourly", on: { kind: "schedule", cron: "0 * * * *" }, action: { kind: "reconcile" } }],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.rejected).toEqual([]);
    expect(result.triggers[0]?.fire).toEqual({ kind: "schedule", cron: "0 * * * *" });
  });

  test("a schedule entry whose cron field isn't cron-shaped is refused with a reason", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "bad-cron", on: { kind: "schedule", cron: "every night" }, action: { kind: "reconcile" } }],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reasons.join(" ")).toContain("cron");
  });
});

describe("loadTriggersConfig: an empty file", () => {
  test("a zero-byte triggers.json is refused as a file problem, not parsed as zero entries silently succeeding", async () => {
    const root = await projectWith("");
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBe("not-json");
  });

  test("an explicit empty triggers array is valid and loads zero entries", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [] }));
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBeUndefined();
  });
});

describe("loadTriggersConfig: a file that is not JSON", () => {
  test("garbage content is refused with fileProblem 'not-json', never throws", async () => {
    const root = await projectWith("this is not json at all {{{");
    const result = loadTriggersConfig(root);
    expect(result.triggers).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.fileProblem).toBe("not-json");
  });
});

describe("loadTriggersConfig: other whole-file problems", () => {
  test("a JSON array at the top level (not an object) is refused as 'not-an-object'", async () => {
    const root = await projectWith(JSON.stringify([{ name: "x" }]));
    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBe("not-an-object");
  });

  test("a wrong schemaVersion is refused rather than guessed at", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 2, triggers: [] }));
    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBe("wrong-schema-version");
  });

  test("triggers not an array is refused as 'triggers-not-an-array'", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: { oops: true } }));
    const result = loadTriggersConfig(root);
    expect(result.fileProblem).toBe("triggers-not-an-array");
  });
});

describe("triggerEntryProblems", () => {
  test("a fully valid entry has no problems", () => {
    expect(
      triggerEntryProblems({
        name: "ok",
        on: { kind: "event", event: "post-merge" },
        action: { kind: "reconcile" },
      }),
    ).toEqual([]);
  });

  test("a non-object entry is one problem, not a throw", () => {
    expect(triggerEntryProblems("not an object")).toEqual(["entry: must be an object"]);
    expect(triggerEntryProblems(null)).toEqual(["entry: must be an object"]);
    expect(triggerEntryProblems(42)).toEqual(["entry: must be an object"]);
  });

  test("a name unsafe as a CLI argument is rejected with a reason naming the constraint", () => {
    const problems = triggerEntryProblems({
      name: "has a space",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "reconcile" },
    });
    expect(problems.some((p) => p.startsWith("name:"))).toBe(true);
  });

  test("open-flow without a template is rejected", () => {
    const problems = triggerEntryProblems({
      name: "ok",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "open-flow" },
    });
    expect(problems.some((p) => p.includes("template"))).toBe(true);
  });

  test("flow-next without a flow id is rejected", () => {
    const problems = triggerEntryProblems({
      name: "ok",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "flow-next" },
    });
    expect(problems.some((p) => p.includes("action.flow"))).toBe(true);
  });

  test("an unknown action kind is rejected with the allowed list", () => {
    const problems = triggerEntryProblems({
      name: "ok",
      on: { kind: "event", event: "post-merge" },
      action: { kind: "teleport" },
    });
    expect(problems.some((p) => p.includes("action.kind"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flow 290 (AC1, AC4, AC6): the `dispatch` block on `flow-next`.
// ---------------------------------------------------------------------------

const VALID_DISPATCH = {
  provider: "anthropic",
  model: "claude-sonnet",
  permissionMode: "trust",
  rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  ceilingUsd: 2,
  maxSeconds: 600,
};

function flowNextWith(dispatch: unknown): unknown {
  return { name: "overnight", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "flow-next", flow: "290", dispatch } };
}

describe("flow-next dispatch block (flow 290)", () => {
  test("a full dispatch block loads, with maxAttempts defaulted", async () => {
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [flowNextWith(VALID_DISPATCH)] }));
    const result = loadTriggersConfig(root);
    expect(result.rejected).toEqual([]);
    const action = result.triggers[0]!.action;
    expect(action.kind).toBe("flow-next");
    if (action.kind === "flow-next") {
      expect(action.dispatch).toEqual({ ...VALID_DISPATCH, permissionMode: "trust", maxAttempts: 3 } as never);
    }
  });

  test("permissionMode defaults to ask and maxSeconds to 1800", async () => {
    const { permissionMode: _p, maxSeconds: _m, ...rest } = VALID_DISPATCH;
    const root = await projectWith(JSON.stringify({ schemaVersion: 1, triggers: [flowNextWith(rest)] }));
    const action = loadTriggersConfig(root).triggers[0]!.action;
    if (action.kind !== "flow-next" || action.dispatch === undefined) throw new Error("expected a dispatch");
    expect(action.dispatch.permissionMode).toBe("ask");
    expect(action.dispatch.maxSeconds).toBe(1800);
  });

  test('AC4: permissionMode "auto" is rejected at load with a stated reason', () => {
    const problems = triggerEntryProblems(flowNextWith({ ...VALID_DISPATCH, permissionMode: "auto" }));
    expect(problems.some((p) => p.includes('"auto" is never allowed for an unattended run'))).toBe(true);
  });

  test("AC6: a dispatch without rates is rejected — an unpriced dispatch cannot be bounded", () => {
    const { rates: _r, ...rest } = VALID_DISPATCH;
    const problems = triggerEntryProblems(flowNextWith(rest));
    expect(problems.some((p) => p.startsWith("action.dispatch.rates: required") && p.includes("unpriced"))).toBe(true);
  });

  test("AC6: a dispatch without ceilingUsd is rejected", () => {
    const { ceilingUsd: _c, ...rest } = VALID_DISPATCH;
    const problems = triggerEntryProblems(flowNextWith(rest));
    expect(problems.some((p) => p.startsWith("action.dispatch.ceilingUsd: required"))).toBe(true);
  });

  test("malformed rates, a zero ceiling and a missing model are each named", () => {
    const problems = triggerEntryProblems(
      flowNextWith({ ...VALID_DISPATCH, model: "", ceilingUsd: 0, rates: { inputUsdPerMTok: -1, outputUsdPerMTok: "x" } }),
    );
    expect(problems).toContain("action.dispatch.model: required, non-empty string");
    expect(problems).toContain("action.dispatch.ceilingUsd: must be a positive number of USD");
    expect(problems.some((p) => p.startsWith("action.dispatch.rates.inputUsdPerMTok"))).toBe(true);
    expect(problems.some((p) => p.startsWith("action.dispatch.rates.outputUsdPerMTok"))).toBe(true);
  });

  test("a rejected dispatch entry does not take the other entries down with it", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [
          flowNextWith({ ...VALID_DISPATCH, permissionMode: "auto" }),
          { name: "nightly", on: { kind: "schedule", cron: "0 3 * * *" }, action: { kind: "rebuild" } },
        ],
      }),
    );
    const result = loadTriggersConfig(root);
    expect(result.triggers.map((t) => t.name)).toEqual(["nightly"]);
    expect(result.rejected.map((r) => r.name)).toEqual(["overnight"]);
  });

  test("a flow-next with no dispatch block still loads as report-only", async () => {
    const root = await projectWith(
      JSON.stringify({
        schemaVersion: 1,
        triggers: [{ name: "report", on: { kind: "event", event: "post-merge" }, action: { kind: "flow-next", flow: "290" } }],
      }),
    );
    const action = loadTriggersConfig(root).triggers[0]!.action;
    expect(action).toEqual({ kind: "flow-next", flow: "290" });
  });
});

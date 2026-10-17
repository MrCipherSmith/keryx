import { expect, test } from "bun:test";
import type { RecordedResolve } from "../gdskills/context-resolver";
import type { ProjectContextStatus } from "../gdskills/project-context-status";
import type { OpenModalInput } from "./modal-host";
import {
  NO_RESOLVE_TEXT,
  PROJECT_CONTEXT_CONFIG_REFUSAL,
  formatProjectContextLastLines,
  formatProjectContextStatusLines,
  isProjectContextCommand,
  parseProjectContextCommand,
  presentProjectContext,
  projectContextFooter,
  renderProjectContextSidebarValue,
  type EnforcementMode,
  type ProjectContextModalOptions,
} from "./project-context-inspector";
import { applyThemeId, getThemeId } from "./theme";

// Matrix: docs/requirements/keryx-project-implementation-rules/TUI-states.md

const base: ProjectContextStatus = {
  enforcement: "warn",
  enforcementSource: "default",
  maxBytes: 131072,
  maxBytesSource: "default",
  ruleCount: 0,
  linkedCount: 0,
};

const recorded = (exceeded: boolean): RecordedResolve => ({
  recordedAt: "2026-10-17T10:00:00.000Z",
  result: {
    schema: 1,
    for: "implement",
    files: ["src/a.ts"],
    entries: [
      { kind: "rule", source: "project", path: ".metaproject/rules/project/AGENTS.mdc", sha256: "x", bytes: 10, reason: "always", tier: "must_read" },
      { kind: "rule", source: "project", path: ".metaproject/rules/project/big.mdc", sha256: "y", bytes: 99, reason: "glob:src/**", tier: "on_demand", shadows: "bundled/x.mdc" },
    ],
    budget: { limitBytes: 131072, usedBytes: 109, exceeded, limitSource: "default" },
    warnings: ["something odd"],
  } as RecordedResolve["result"],
});

const S0 = base;
const S1: ProjectContextStatus = { ...base, ruleCount: 3, linkedCount: 1 };
const S2: ProjectContextStatus = { ...S1, last: recorded(false) };
const S3: ProjectContextStatus = { ...S1, last: recorded(true) };
const S4: ProjectContextStatus = { ...S1, configError: "tasks.config.json is not valid JSON" };
const S5: ProjectContextStatus = { ...S1, lastError: ".metaproject/data/skills/project-context/last.json is not valid JSON" };

type Node = { id: string; content: unknown };

function harness(initial: ProjectContextStatus, overrides: Partial<ProjectContextModalOptions> = {}) {
  let nodes: Node[] = [];
  let keyHandler: ((key: { name: string; sequence: string }) => void) | undefined;
  let keyOff = 0;
  let input: OpenModalInput | undefined;
  const body = {
    add: (child: Node) => nodes.push(child),
    getChildren: () => [...nodes],
    remove: (child: Node) => {
      nodes = nodes.filter((node) => node !== child);
    },
  };
  const otui = {
    TextRenderable: class {
      id: string;
      content: unknown;
      constructor(_r: unknown, o: { id: string; content: unknown }) {
        this.id = o.id;
        this.content = o.content;
      }
    },
  };
  const written: EnforcementMode[] = [];
  const errors: string[] = [];
  const seen: ProjectContextStatus[] = [];
  let current = initial;
  const handle = presentProjectContext(
    ((_o: unknown, _c: unknown, i: OpenModalInput) => {
      input = i;
      i.renderTab("status", body, {} as never);
      return { close: () => i.onClose?.() };
    }) as never,
    otui,
    {},
    {
      initial,
      loadStatus: async () => current,
      setEnforcement: async (mode) => {
        written.push(mode);
        current = { ...current, enforcement: mode, enforcementSource: "config" };
      },
      onKeypress: (handler) => {
        keyHandler = handler;
        return () => {
          keyOff += 1;
        };
      },
      onError: (message) => errors.push(message),
      onStatus: (s) => seen.push(s),
      ...overrides,
    },
  );
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    handle: handle as { close(): void },
    text: () => nodes.map((n) => String(n.content)).join("\n"),
    node: () => nodes[0],
    tab: (id: string) => input?.renderTab(id, body, {} as never),
    press: async (name: string) => {
      keyHandler?.({ name, sequence: name });
      await flush();
    },
    written,
    errors,
    seen,
    keyOff: () => keyOff,
    footer: () => input?.footer,
  };
}

test("parse and recognise the command", () => {
  expect(isProjectContextCommand("/projectctx")).toBe(true);
  expect(isProjectContextCommand("  /projectctx block")).toBe(true);
  expect(isProjectContextCommand("/projectctxx")).toBe(false);
  expect(parseProjectContextCommand("/projectctx")).toEqual({ kind: "open" });
  expect(parseProjectContextCommand("/projectctx warn")).toEqual({ kind: "set", mode: "warn" });
  expect(parseProjectContextCommand("/projectctx block")).toEqual({ kind: "set", mode: "block" });
  // E4
  expect(parseProjectContextCommand("/projectctx x")).toEqual({
    kind: "invalid",
    message: "Unknown /projectctx argument 'x'. Usage: /projectctx [warn|block]",
  });
  expect(parseProjectContextCommand("/projectctx block now").kind).toBe("invalid");
});

test("sidebar: S0 hidden, S1..S5 follow the matrix", () => {
  expect(renderProjectContextSidebarValue(S0)).toBeUndefined();
  expect(renderProjectContextSidebarValue(S1)).toBe("warn · 3 rules");
  expect(renderProjectContextSidebarValue(S2)).toBe("warn · 3 rules");
  expect(renderProjectContextSidebarValue(S3)).toBe("warn · 3 rules · cap exceeded");
  expect(renderProjectContextSidebarValue(S4)).toBe("warn · 3 rules · config unreadable");
  expect(renderProjectContextSidebarValue(S5)).toBe("warn · 3 rules");
  // A recorded resolve with no rules still shows the row; one rule is singular.
  expect(renderProjectContextSidebarValue({ ...S0, last: recorded(false) })).toBe("warn · 0 rules");
  expect(renderProjectContextSidebarValue({ ...S0, ruleCount: 1 })).toBe("warn · 1 rule");
  expect(renderProjectContextSidebarValue({ ...S0, enforcement: "block" , ruleCount: 2 })).toBe("block · 2 rules");
});

test("E2 on the sidebar: S0 toggled to block appears as 'block · 0 rules' once a record or rule exists", () => {
  expect(renderProjectContextSidebarValue({ ...S0, enforcement: "block", last: recorded(false) })).toBe("block · 0 rules");
});

test("status lines: S0 defaults, S4 config problem, S3 cap hint", () => {
  expect(formatProjectContextStatusLines(S0)).toEqual([
    "Enforcement: warn (default)",
    "Context cap: 131072 bytes (default)",
    "Project rules: 0 (0 linked)",
  ]);
  expect(formatProjectContextStatusLines(S4).join("\n")).toContain("config unreadable: tasks.config.json is not valid JSON; defaults used");
  expect(formatProjectContextStatusLines(S3).join("\n")).toContain(
    "cap exceeded: raise gdskills.projectContext.maxBytes (now 131072, from default)",
  );
  expect(formatProjectContextStatusLines(S2).join("\n")).not.toContain("cap exceeded");
  expect(formatProjectContextStatusLines({ ...S1, enforcement: "block", enforcementSource: "config" })[0]).toBe("Enforcement: block (config)");
});

test("last resolve lines: none, unreadable, tiers with shadows and warnings", () => {
  expect(formatProjectContextLastLines(S0)).toEqual([NO_RESOLVE_TEXT]);
  expect(formatProjectContextLastLines(S1)).toEqual([NO_RESOLVE_TEXT]);
  expect(formatProjectContextLastLines(S5)).toEqual([`last resolve unreadable: ${S5.lastError}`]);
  const text = formatProjectContextLastLines(S2).join("\n");
  expect(text).toContain("must_read (1):");
  expect(text).toContain("on_demand (1):");
  expect(text).toContain("AGENTS.mdc [project] always");
  expect(text).toContain("shadows bundled/x.mdc");
  expect(text).toContain("warnings (1):");
  expect(text).toContain("something odd");
});

test("footer: the e key is labelled off while the config is unreadable", () => {
  expect(projectContextFooter(S0)[0]).toEqual({ key: "e", label: "toggle warn/block" });
  expect(projectContextFooter(S4)[0]?.label).toContain("fix tasks.config.json");
});

test("E1 open: Status tab first, Last resolve tab on switch", () => {
  const h = harness(S2);
  expect(h.text()).toContain("Enforcement: warn (default)");
  h.tab("last");
  expect(h.text()).toContain("must_read (1):");
  expect(h.text()).not.toContain("Enforcement:");
  const h0 = harness(S0);
  h0.tab("last");
  expect(h0.text()).toBe(NO_RESOLVE_TEXT);
});

test("E2 toggle: warn -> block writes, reloads, repaints and reports the new status", async () => {
  const h = harness(S1);
  await h.press("e");
  expect(h.written).toEqual(["block"]);
  expect(h.text()).toContain("Enforcement: block (config)");
  expect(h.seen).toHaveLength(1);
  await h.press("e");
  expect(h.written).toEqual(["block", "warn"]);
});

test("E2 on S4: refuses with the system line, writes nothing", async () => {
  const h = harness(S4);
  await h.press("e");
  expect(h.written).toEqual([]);
  expect(h.errors).toEqual([PROJECT_CONTEXT_CONFIG_REFUSAL]);
});

test("E2 reports a failing write and keeps the modal usable", async () => {
  const h = harness(S1, {
    setEnforcement: async () => {
      throw new Error("tasks.config.json is not valid JSON — refusing to overwrite it.");
    },
  });
  await h.press("e");
  expect(h.errors).toEqual(["tasks.config.json is not valid JSON — refusing to overwrite it."]);
  await h.press("e");
  expect(h.errors).toHaveLength(2);
});

test("other keys, and input blocked by another surface, do nothing", async () => {
  const h = harness(S1, { inputBlocked: () => true });
  await h.press("e");
  await h.press("x");
  expect(h.written).toEqual([]);
  const h2 = harness(S1);
  await h2.press("x");
  expect(h2.written).toEqual([]);
});

test("E6 theme change repaints an open modal; E7 close removes the key listener and stops repainting", async () => {
  const h = harness(S1);
  const before = h.node();
  applyThemeId(getThemeId());
  expect(h.node()).not.toBe(before);
  expect(h.text()).toContain("Enforcement: warn");
  const afterOpen = h.node();
  h.handle.close();
  expect(h.keyOff()).toBe(1);
  applyThemeId(getThemeId());
  expect(h.node()).toBe(afterOpen);
  // a key after close is ignored
  await h.press("e");
  expect(h.written).toEqual([]);
});

test("a host that declines to mount returns undefined", () => {
  const out = presentProjectContext((() => undefined) as never, {}, {}, {
    initial: S0,
    loadStatus: async () => S0,
    setEnforcement: async () => {},
    onKeypress: () => () => {},
  });
  expect(out).toBeUndefined();
});

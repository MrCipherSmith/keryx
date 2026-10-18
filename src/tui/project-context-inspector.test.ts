import { expect, test } from "bun:test";
import type { RecordedResolve } from "../gdskills/context-resolver";
import type { ProjectContextStatus } from "../gdskills/project-context-status";
import type { OpenModalInput } from "./modal-host";
import type { ReferenceDeclaration } from "../gdskills/references-config";
import type { ReferencesFinding } from "../gdskills/references-check";
import {
  NO_REFERENCES_TEXT,
  NO_RESOLVE_TEXT,
  PROJECT_CONTEXT_CONFIG_REFUSAL,
  createProjectContextFeed,
  formatProjectContextLastLines,
  formatProjectContextStatusLines,
  formatProjectReferencesLines,
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
      { kind: "rule", source: "project", path: ".metaproject/rules/project/big.mdc", sha256: "y", bytes: 99, reason: "glob:src/**", tier: "on_demand", shadows: "bundled/x.mdc", also_at: ["copy/y.mdc"] },
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
    opened: () => input,
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
    message: "Unknown /projectctx argument 'x'. Usage: /projectctx [warn|block|refs]",
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
  expect(text).toContain("also at copy/y.mdc");
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

// ---------------------------------------------------------------------------
// flow 462 (AC16): conditional references. States:
// docs/requirements/keryx-conditional-reads/TUI-states.md (R0..R7 below).
// ---------------------------------------------------------------------------

const STYLING: ReferenceDeclaration = {
  path: "STYLING.md",
  when: { globs: ["src/**/*.css"], keywords: ["className"] },
  anchor: "Class conventions",
  description: "Class naming and cascade rules for stylesheets.",
};
const THEMING: ReferenceDeclaration = {
  path: "THEMING.md",
  when: { globs: [], keywords: ["theme"] },
  description: "Theme tokens and dark mode handling.",
};

const declared = (findings: ReferencesFinding[] = []): NonNullable<ProjectContextStatus["references"]> => ({
  state: "declared",
  declarations: [STYLING, THEMING],
  findings,
});

type RefEntry = RecordedResolve["result"]["entries"][number];
const refEntry = (declaration: ReferenceDeclaration, reason: string, extra: Partial<RefEntry> = {}): RefEntry => ({
  kind: "contract",
  source: "project",
  path: declaration.path,
  sha256: "z",
  bytes: 900,
  reason,
  tier: reason === "declared" ? "on_demand" : "must_read",
  description: declaration.description,
  ...(declaration.anchor !== undefined ? { anchor: declaration.anchor } : {}),
  condition: declaration.when,
  ...extra,
});

const resolved = (entries: RefEntry[], exceeded = false): RecordedResolve => {
  const base = recorded(exceeded);
  return { ...base, result: { ...base.result, entries } };
};

const promotedStyling = refEntry(STYLING, "condition:glob:src/**/*.css", { section_bytes: 120 });
const onDemandTheming = refEntry(THEMING, "declared");

const finding = (code: ReferencesFinding["code"], where: string, severity: ReferencesFinding["severity"] = "warning"): ReferencesFinding => ({
  severity,
  code,
  path: where,
  message: `${code} message for ${where}`,
});

test("R0 no references file: no refs segment, the tab is one line naming the suggest command", () => {
  expect(renderProjectContextSidebarValue(S1)).toBe("warn · 3 rules");
  expect(renderProjectContextSidebarValue(S2)).toBe("warn · 3 rules");
  expect(formatProjectReferencesLines(S1)).toEqual([NO_REFERENCES_TEXT]);
  expect(NO_REFERENCES_TEXT).toContain("keryx skills references suggest");
  const h = harness(S1);
  h.tab("references");
  expect(h.text()).toBe(NO_REFERENCES_TEXT);
});

test("R1 declared, no resolve yet: refs -/<n>; rows show condition and anchor and 'not resolved'", () => {
  const status: ProjectContextStatus = { ...S1, references: declared() };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs -/2");
  // The row is shown even with no rules and no recorded resolve.
  expect(renderProjectContextSidebarValue({ ...S0, references: declared() })).toBe("warn · 0 rules · refs -/2");
  const lines = formatProjectReferencesLines(status);
  expect(lines[0]).toBe("References: 2 declared, no resolve yet");
  const text = lines.join("\n");
  expect(text).toContain("STYLING.md § Class conventions");
  expect(text).toContain("glob src/**/*.css");
  expect(text).toContain("keyword className");
  expect(text).toContain("THEMING.md");
  expect(text).toContain("keyword theme");
  expect(text.match(/not resolved/g)).toHaveLength(2);
  // An unreadable last.json is "no resolve" for the counters; the Last resolve tab says why.
  expect(renderProjectContextSidebarValue({ ...status, lastError: "x" })).toBe("warn · 3 rules · refs -/2");
});

test("R2 resolved, some promoted: refs <p>/<n>; each row has status, reason and section bytes", () => {
  const status: ProjectContextStatus = { ...S1, references: declared(), last: resolved([promotedStyling, onDemandTheming]) };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs 1/2");
  const lines = formatProjectReferencesLines(status);
  expect(lines[0]).toBe("References: 1 promoted of 2 declared");
  const text = lines.join("\n");
  expect(text).toContain("promoted · matched glob src/**/*.css · section 120 bytes");
  expect(text).toContain("on demand · Theme tokens and dark mode handling.");
  expect(text).not.toContain("not resolved");
  expect(text).not.toContain("over the cap");
  // A keyword reason reads as the keyword; a document without an anchor shows its whole size.
  const byKeyword: ProjectContextStatus = { ...status, last: resolved([refEntry(STYLING, "condition:keyword:className"), refEntry(THEMING, "condition:keyword:theme")]) };
  const keywordText = formatProjectReferencesLines(byKeyword).join("\n");
  expect(keywordText).toContain("promoted · matched keyword className · 900 bytes");
  expect(renderProjectContextSidebarValue(byKeyword)).toBe("warn · 3 rules · refs 2/2");
});

test("R2 only declared entries count: a cited contract has no condition and is not a reference", () => {
  const cited: RefEntry = { kind: "contract", source: "project", path: "OTHER.md", sha256: "q", bytes: 5, reason: "cited by AGENTS.mdc", tier: "must_read" };
  const status: ProjectContextStatus = { ...S1, references: declared(), last: resolved([cited, promotedStyling, onDemandTheming]) };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs 1/2");
});

test("R2 a declaration the last resolve did not list says so", () => {
  const status: ProjectContextStatus = { ...S1, references: declared(), last: resolved([promotedStyling]) };
  expect(formatProjectReferencesLines(status).join("\n")).toContain("not in the last resolve");
});

test("R3 resolved, none promoted: refs 0/<n>; rows are on demand with their description", () => {
  const status: ProjectContextStatus = { ...S1, references: declared(), last: resolved([refEntry(STYLING, "declared"), onDemandTheming]) };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs 0/2");
  const lines = formatProjectReferencesLines(status);
  expect(lines[0]).toBe("References: 0 promoted of 2 declared");
  const text = lines.join("\n");
  expect(text).toContain("on demand · Class naming and cascade rules for stylesheets.");
  expect(text).toContain("on demand · Theme tokens and dark mode handling.");
  expect(text).not.toContain("promoted ·");
});

test("R4 promoted over the cap: the existing marker stays, the promoted row shows its bytes and the warning", () => {
  const status: ProjectContextStatus = { ...S1, references: declared(), last: resolved([promotedStyling, onDemandTheming], true) };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs 1/2 · cap exceeded");
  const text = formatProjectReferencesLines(status).join("\n");
  expect(text).toContain("section 120 bytes");
  expect(text.match(/over the cap/g)).toHaveLength(1);
  expect(text).toContain("over the cap: 109 of 131072 bytes");
});

test("R5 problems from check: refs <p>/<n> !<k>; the tab lists them under the rows", () => {
  const findings = [
    finding("anchor-not-found", "STYLING.md", "error"),
    finding("description-short", "THEMING.md"),
    finding("undeclared-citation", "docs/OTHER.md"),
  ];
  const status: ProjectContextStatus = { ...S1, references: declared(findings), last: resolved([promotedStyling, onDemandTheming]) };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs 1/2 !3");
  expect(renderProjectContextSidebarValue({ ...S1, references: declared(findings) })).toBe("warn · 3 rules · refs -/2 !3");
  const lines = formatProjectReferencesLines(status);
  const header = lines.indexOf("problems (3):");
  expect(header).toBeGreaterThan(lines.findIndex((line) => line.startsWith("THEMING.md")));
  const problems = lines.slice(header + 1).join("\n");
  expect(problems).toContain("[error] anchor-not-found STYLING.md: anchor-not-found message for STYLING.md");
  expect(problems).toContain("[warning] description-short THEMING.md");
  expect(problems).toContain("[warning] undeclared-citation docs/OTHER.md");
  // No problems, no section.
  expect(formatProjectReferencesLines({ ...S1, references: declared() }).join("\n")).not.toContain("problems");
});

test("R6 invalid references file: refs ?; the tab shows the validation messages that name the entry", () => {
  const errors = ['.metaproject/rules/project/references.json: references[1] ("THEMING.md"): when needs at least one of globs or keywords'];
  const status: ProjectContextStatus = { ...S1, references: { state: "invalid", errors }, last: resolved([promotedStyling]) };
  expect(renderProjectContextSidebarValue(status)).toBe("warn · 3 rules · refs ?");
  expect(renderProjectContextSidebarValue({ ...S0, references: { state: "invalid", errors } })).toBe("warn · 0 rules · refs ?");
  const lines = formatProjectReferencesLines(status);
  expect(lines[0]).toBe("References file is invalid:");
  expect(lines.join("\n")).toContain('references[1] ("THEMING.md")');
  expect(lines.join("\n")).not.toContain("promoted");
});

test("R7 a new resolve recorded updates the counters and the open tab in place", async () => {
  const before: ProjectContextStatus = { ...S1, references: declared() };
  const after: ProjectContextStatus = { ...S1, references: declared(), last: resolved([promotedStyling, onDemandTheming]) };
  expect(renderProjectContextSidebarValue(before)).toBe("warn · 3 rules · refs -/2");
  expect(renderProjectContextSidebarValue(after)).toBe("warn · 3 rules · refs 1/2");

  let push: ((status: ProjectContextStatus) => void) | undefined;
  let unsubscribed = 0;
  const h = harness(before, {
    subscribe: (listener) => {
      push = listener;
      return () => {
        unsubscribed += 1;
      };
    },
  });
  h.tab("references");
  expect(h.text()).toContain("no resolve yet");
  const node = h.node();
  push?.(after);
  expect(h.text()).toContain("References: 1 promoted of 2 declared");
  expect(h.text()).not.toContain("no resolve yet");
  expect(h.node()).not.toBe(node);
  // Another tab follows too, and the Status tab keeps its own text.
  h.tab("status");
  expect(h.text()).toContain("Enforcement: warn (default)");
  h.handle.close();
  expect(unsubscribed).toBe(1);
  push?.(before);
  expect(h.text()).toContain("Enforcement: warn (default)");
});

test("R7 the feed reloads on an interval and tells listeners only when the status changed", async () => {
  let tick: (() => Promise<void>) | undefined;
  let intervalMs = 0;
  let stopped = 0;
  let current: ProjectContextStatus = { ...S1, references: declared() };
  let failure: Error | undefined;
  const errors: string[] = [];
  const feed = createProjectContextFeed({
    load: async () => {
      if (failure !== undefined) throw failure;
      return structuredClone(current);
    },
    interval: (run, ms) => {
      tick = run;
      intervalMs = ms;
      return () => {
        stopped += 1;
      };
    },
    onError: (message) => errors.push(message),
  });
  expect(intervalMs).toBe(5000);
  expect(feed.current()).toBeUndefined();
  const seen: ProjectContextStatus[] = [];
  const off = feed.subscribe((status) => seen.push(status));

  expect(await feed.reload()).toEqual(current);
  expect(feed.current()).toEqual(current);
  expect(seen).toHaveLength(1);
  await feed.reload();
  await tick?.();
  expect(seen).toHaveLength(1);

  current = { ...current, last: resolved([promotedStyling, onDemandTheming]) };
  await tick?.();
  expect(seen).toHaveLength(2);
  expect(renderProjectContextSidebarValue(seen[1] as ProjectContextStatus)).toBe("warn · 3 rules · refs 1/2");

  // A failing load is reported once, not on every tick, and recovery re-arms the report.
  failure = new Error("disk gone");
  await tick?.();
  await tick?.();
  expect(errors).toEqual(["disk gone"]);
  failure = undefined;
  await tick?.();
  failure = new Error("again");
  await tick?.();
  expect(errors).toEqual(["disk gone", "again"]);
  failure = undefined;

  off();
  current = { ...current, enforcement: "block" };
  await tick?.();
  expect(seen).toHaveLength(2);
  feed.stop();
  expect(stopped).toBe(1);
});

test("/projectctx refs opens the modal on the References tab", () => {
  expect(parseProjectContextCommand("/projectctx refs")).toEqual({ kind: "open", tab: "references" });
  expect(parseProjectContextCommand("/projectctx")).toEqual({ kind: "open" });
  expect(parseProjectContextCommand("/projectctx refs now").kind).toBe("invalid");
  const h = harness({ ...S1, references: declared() }, { initialTab: "references" });
  expect(h.opened()?.initialTab).toBe("references");
  expect(h.opened()?.tabs.map((tab) => tab.id)).toEqual(["status", "last", "references"]);
  expect(harness(S1).opened()?.initialTab).toBe("status");
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

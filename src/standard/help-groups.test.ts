// Flow 303 (AC1, AC2, AC3): HELP_GROUPS coverage and rendering.
//
// This test file — unlike `help-groups.ts` itself — is free to import
// `CLI_ROUTES` (src/cli.ts, adapter) and `AGENT_SLASH_COMMANDS`
// (src/commands/agent-commands.ts, adapter) directly: `import-policy.ts`'s
// `listSourceFiles` drops every `*.test.ts` file from the scan, so this
// cross-zone read exists ONLY here, never in the production table it checks.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { CLI_ROUTES } from "../cli";
import { AGENT_SLASH_COMMANDS } from "../commands/agent-commands";
import {
  allHelpTokens,
  closestHelpTopics,
  findCliEntry,
  findSlashEntry,
  groupBySlug,
  HELP_GROUP_ORDER,
  HELP_GROUPS,
  HIDDEN_FROM_HELP,
  renderCliGroupHelp,
  renderEntryDetail,
  renderGroupedCliHelp,
  renderGroupedSlashHelp,
} from "./help-groups";

describe("AC1: every CLI_ROUTES verb and every AGENT_SLASH_COMMANDS entry is placed exactly once", () => {
  test("every CLI_ROUTES verb is in exactly one group, or in HIDDEN_FROM_HELP, never both", () => {
    const routeNames = Object.keys(CLI_ROUTES).sort();
    const cliEntries = HELP_GROUPS.filter((e) => e.kind === "cli");
    const cliNames = cliEntries.map((e) => e.name).sort();
    const hiddenNames = HIDDEN_FROM_HELP.map((h) => h.verb).sort();

    // Every hidden entry names a reason, and a real CLI_ROUTES verb — an
    // entry here for a verb that no longer exists is dead weight, not a
    // decision, and would silently stop meaning anything.
    for (const hidden of HIDDEN_FROM_HELP) {
      expect(hidden.reason.length).toBeGreaterThan(0);
      expect(routeNames).toContain(hidden.verb);
    }

    // Never in both: a verb placed in a group AND hidden is a contradiction
    // this table cannot resolve silently.
    const inBoth = cliNames.filter((n) => hiddenNames.includes(n));
    expect(inBoth).toEqual([]);

    const placed = new Set([...cliNames, ...hiddenNames]);
    const missing = routeNames.filter((n) => !placed.has(n));
    const unknown = cliNames.filter((n) => !routeNames.includes(n));
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);

    // No double-placement within HELP_GROUPS itself.
    expect(new Set(cliNames).size).toBe(cliEntries.length);
    // No double-placement within HIDDEN_FROM_HELP itself.
    expect(new Set(hiddenNames).size).toBe(HIDDEN_FROM_HELP.length);
  });

  test("HIDDEN_FROM_HELP is exactly __sandbox-net-forward, session and skill-verify-skill", () => {
    // Pinned, not just "some subset" — a coverage guard that accepted an
    // ever-growing hidden list without anyone noticing would defeat AC1's
    // whole point (every verb accounted for, deliberately, not swept under).
    expect(HIDDEN_FROM_HELP.map((h) => h.verb).sort()).toEqual([
      "__sandbox-net-forward",
      "session",
      "skill-verify-skill",
    ]);
  });

  test("every AGENT_SLASH_COMMANDS entry appears in HELP_GROUPS exactly once", () => {
    const slashNames = AGENT_SLASH_COMMANDS.map((c) => c.name).sort();
    const slashEntries = HELP_GROUPS.filter((e) => e.kind === "slash");
    const tableNames = slashEntries.map((e) => e.name).sort();

    const missing = slashNames.filter((n) => !tableNames.includes(n));
    const unknown = tableNames.filter((n) => !slashNames.includes(n));
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);

    expect(new Set(tableNames).size).toBe(slashEntries.length);
  });

  test("every entry's group is one of the nine onboarding groups, in order", () => {
    const validGroups = new Set(HELP_GROUP_ORDER.map((g) => g.name));
    for (const entry of HELP_GROUPS) {
      expect(validGroups.has(entry.group)).toBe(true);
    }
    expect(HELP_GROUP_ORDER.length).toBe(9);
    expect(HELP_GROUP_ORDER.map((g) => g.name)).toEqual([
      "Start here",
      "Connect a model provider",
      "Look and feel",
      "Working in keryx shell",
      "Project knowledge",
      "Managed work",
      "Automation",
      "External agents, ACP and MCP",
      "Maintenance and diagnostics",
    ]);
  });

  test("group slugs are unique and never collide with a CLI verb name (keryx help <name> is unambiguous)", () => {
    const slugs = HELP_GROUP_ORDER.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const cliNames = new Set(HELP_GROUPS.filter((e) => e.kind === "cli").map((e) => e.name));
    for (const slug of slugs) {
      expect(cliNames.has(slug)).toBe(false);
    }
  });

  test("every group's `tab` and `tabShort` labels (the TUI modal's tab-strip text) are non-empty and each set is unique", () => {
    const tabs = HELP_GROUP_ORDER.map((g) => g.tab);
    const tabsShort = HELP_GROUP_ORDER.map((g) => g.tabShort);
    for (const label of [...tabs, ...tabsShort]) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(tabs).size).toBe(tabs.length);
    expect(new Set(tabsShort).size).toBe(tabsShort.length);
  });
});

describe("AC2: every entry has a one-line description", () => {
  test("every summary is non-empty, single-line, and reasonably short", () => {
    for (const entry of HELP_GROUPS) {
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.summary).not.toContain("\n");
      expect(entry.summary.trim()).toBe(entry.summary);
    }
  });
});

describe("AC3: `keryx help` prints every group in onboarding order, within 80 columns", () => {
  test("renders every group heading in order — including a group with only slash commands — and every CLI verb", () => {
    const text = renderGroupedCliHelp();
    let lastIndex = -1;
    for (const group of HELP_GROUP_ORDER) {
      // Every group in HELP_GROUP_ORDER has at least one entry (cli or
      // slash), so every heading must appear — a group whose only commands
      // are slash commands (e.g. "Look and feel") used to vanish entirely
      // because the old check gated the heading on CLI verbs alone.
      const idx = text.indexOf(`${group.name}:`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    for (const entry of HELP_GROUPS.filter((e) => e.kind === "cli")) {
      expect(text).toContain(entry.name);
    }
  });

  test("every slash command in HELP_GROUPS also appears in the terminal's `keryx help` output, marked as a shell command", () => {
    const text = renderGroupedCliHelp();
    expect(text).toContain("in keryx shell:");
    for (const entry of HELP_GROUPS.filter((e) => e.kind === "slash")) {
      expect(text).toContain(entry.name);
    }
  });

  test("no rendered line exceeds 80 columns, over the real table", () => {
    const text = renderGroupedCliHelp();
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  test("respects a narrower column budget too", () => {
    const text = renderGroupedCliHelp(60);
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  test("HIDDEN_FROM_HELP verbs never appear in the grouped listing", () => {
    // A substring check would false-positive on "session" inside "sessions";
    // a hidden verb's OWN row (`  <name>  <summary>`) is what must be absent.
    const text = renderGroupedCliHelp();
    for (const hidden of HIDDEN_FROM_HELP) {
      const ownRow = new RegExp(`^ {2}${hidden.verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m");
      expect(text).not.toMatch(ownRow);
    }
  });
});

describe("AC4: group view, command detail, and closest-match", () => {
  test("renderCliGroupHelp renders exactly one group's CLI verbs", () => {
    const group = HELP_GROUP_ORDER.find((g) => g.slug === "project-knowledge");
    expect(group).toBeDefined();
    const text = renderCliGroupHelp(group!);
    expect(text).toContain("gdgraph");
    expect(text).toContain("wiki");
    expect(text).not.toContain("Start here:");
  });

  test("`keryx help look-and-feel` lists /theme — a group with no CLI verbs at all must still render its slash commands", () => {
    const group = HELP_GROUP_ORDER.find((g) => g.slug === "look-and-feel");
    expect(group).toBeDefined();
    const text = renderCliGroupHelp(group!);
    expect(text).toContain("Look and feel:");
    expect(text).toContain("in keryx shell:");
    expect(text).toContain("/theme");
    expect(text).toContain("/settings");
    expect(text).toContain("/model");
  });

  test("`keryx help connect` lists both the CLI verbs and the slash commands for that group", () => {
    const group = HELP_GROUP_ORDER.find((g) => g.slug === "connect");
    expect(group).toBeDefined();
    const text = renderCliGroupHelp(group!);
    expect(text).toContain("auth");
    expect(text).toContain("providers");
    expect(text).toContain("in keryx shell:");
    expect(text).toContain("/connect");
    expect(text).toContain("/provider");
  });

  test("groupBySlug resolves a known slug and refuses an unknown one", () => {
    expect(groupBySlug("automation")?.name).toBe("Automation");
    expect(groupBySlug("nope")).toBeUndefined();
  });

  test("findCliEntry / findSlashEntry resolve exact names", () => {
    expect(findCliEntry("shell")?.group).toBe("Start here");
    expect(findSlashEntry("/theme")?.group).toBe("Look and feel");
    expect(findCliEntry("/theme")).toBeUndefined();
    expect(findSlashEntry("/settings")?.group).toBe("Look and feel");
  });

  test("renderEntryDetail names the entry and its summary", () => {
    const entry = findCliEntry("init");
    expect(entry).toBeDefined();
    const detail = renderEntryDetail(entry!);
    expect(detail).toContain("init");
    expect(detail).toContain(entry!.summary);
  });

  test("renderEntryDetail wraps the slash-command explainer sentence to 80 columns (unwrapped it runs to 94)", () => {
    const entry = findSlashEntry("/connect");
    expect(entry).toBeDefined();
    const detail = renderEntryDetail(entry!);
    for (const line of detail.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(detail).toContain("keryx shell");
    expect(detail).toContain("no standalone CLI form");
  });

  test("every `keryx help <anything>` output stays within 80 columns: every group, every CLI verb, every slash command", () => {
    for (const group of HELP_GROUP_ORDER) {
      for (const line of renderCliGroupHelp(group).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    }
    for (const entry of HELP_GROUPS) {
      for (const line of renderEntryDetail(entry).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    }
  });

  test("closestHelpTopics suggests near misses for a typo'd topic", () => {
    const suggestions = closestHelpTopics("automaton"); // one letter off "automation"
    expect(suggestions).toContain("automation");
  });

  test("closestHelpTopics returns nothing for a wildly unrelated query", () => {
    expect(closestHelpTopics("zzzzzzzzzzzzzzzzzzzz")).toEqual([]);
  });

  test("allHelpTokens includes every group slug and every entry name", () => {
    const tokens = allHelpTokens();
    for (const group of HELP_GROUP_ORDER) {
      expect(tokens).toContain(group.slug);
    }
    for (const entry of HELP_GROUPS) {
      expect(tokens).toContain(entry.name);
    }
  });
});

describe("AC7 support: renderGroupedSlashHelp restricts to the given names", () => {
  test("only lists allowed names, grouped, under 80 columns", () => {
    const allow = ["/help", "/theme", "/exit"];
    const text = renderGroupedSlashHelp(allow);
    expect(text).toContain("/help");
    expect(text).toContain("/theme");
    expect(text).toContain("/exit");
    expect(text).not.toContain("/delegate");
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

// Flow 376 review (m2): remote control is a feature the operator is told about in
// four places. The docs shipped with the code once and then drifted; this keeps the
// four from going quiet again, and keeps the version above the release before it.
describe("remote control is documented where operators look", () => {
  const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

  for (const file of [
    "README.md",
    "docs/docs/cli-reference.md",
    ".metaproject/wiki/architecture/remote-control.md",
    "CHANGELOG.md",
  ]) {
    test(`${file} mentions remote control`, () => {
      expect(read(file)).toMatch(/remote[- ]control/i);
    });
  }

  test("the CLI reference names the shell token rotation, the 500 cap and the dropped-lines notice", () => {
    const reference = read("docs/docs/cli-reference.md");
    expect(reference).toContain("minted fresh every time `serve` starts");
    expect(reference).toContain("At most 500 undelivered lines");
    expect(reference).toContain("Turning remote control off from the shell");
  });

  test("package.json is above 0.3.46, the version before remote control", () => {
    const parts = (JSON.parse(read("package.json")) as { version: string }).version
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    const [major = 0, minor = 0, patch = 0] = parts;
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThan(3_046);
  });
});

// Flow 397 (AC6): the approval ack and its "not confirmed" ending are told in the same four
// places, and the version is above 0.3.64, the release before it.
describe("the approval ack is documented where operators look", () => {
  const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

  for (const file of [
    "README.md",
    "docs/docs/cli-reference.md",
    ".metaproject/wiki/architecture/remote-control.md",
    "CHANGELOG.md",
  ]) {
    test(`AC6: ${file} names the approval ack and the "not confirmed" ending`, () => {
      const text = read(file).replace(/\s+/g, " ");
      expect(text).toContain("not confirmed");
      expect(text).toMatch(/approval-ack|confirmed by the shell|confirm\w* (?:it )?received/);
    });
  }

  test("AC6: the guide describes the ack, the wait and the counter", () => {
    const text = read("docs/docs/guides/drive-keryx-remotely.md").replace(/\s+/g, " ");
    expect(text).toContain("approval-ack");
    expect(text).toContain("not confirmed");
    expect(text).toContain("5 seconds");
    expect(text).toContain("Approvals not confirmed");
  });

  for (const file of [
    "README.md",
    "docs/docs/cli-reference.md",
    "docs/docs/guides/drive-keryx-remotely.md",
    ".metaproject/wiki/architecture/remote-control.md",
    "CHANGELOG.md",
  ]) {
    test(`F2: ${file} says the ack carries whether the answer was applied, and the "Not applied" ending`, () => {
      const text = read(file).replace(/\s+/g, " ");
      expect(text).toMatch(/not applied|Not applied/);
      expect(text).toMatch(/applied/);
    });
  }

  // Flow 397 review T-4: the bump is read from the release notes, not from a number that goes stale. The
  // entry that tells the approval ack sits under a version above 0.3.66 (main when the flow merged), and
  // package.json is at or past that version, so a missing or lowered bump fails at any later release.
  test("AC6: the approval ack is released under a version above 0.3.66, and package.json has reached it", () => {
    const parse = (version: string): number => {
      const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
      return major * 1_000_000 + minor * 1_000 + patch;
    };
    const sections = read("CHANGELOG.md").split(/^## \[/m).slice(1);
    const entry = sections.find((section) => section.includes("Approval answers from Telegram are confirmed by the shell"));
    expect(entry).toBeDefined();
    const released = /^(\d+\.\d+\.\d+)\]/.exec(entry ?? "")?.[1];
    expect(released).toBeDefined();
    expect(parse(released ?? "0.0.0")).toBeGreaterThan(parse("0.3.66"));
    const current = (JSON.parse(read("package.json")) as { version: string }).version;
    expect(parse(current)).toBeGreaterThanOrEqual(parse(released ?? "0.0.0"));
  });
});

// Flow 377: `/channels` is told in the same places, and the version is above 0.3.48.
describe("/channels is documented where operators look", () => {
  const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

  for (const file of [
    "README.md",
    "docs/docs/cli-reference.md",
    "docs/docs/commands-by-task.md",
    "docs/docs/guides/drive-keryx-remotely.md",
    ".metaproject/wiki/architecture/remote-control.md",
    "CHANGELOG.md",
  ]) {
    test(`${file} mentions /channels`, () => {
      expect(read(file)).toContain("/channels");
    });
  }

  test("package.json is above 0.3.48, the version before /channels", () => {
    const [major = 0, minor = 0, patch = 0] = (JSON.parse(read("package.json")) as { version: string }).version
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThan(3_048);
  });
});

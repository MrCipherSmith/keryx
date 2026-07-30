// Coverage guard for the command descriptor registry (flow 087, item 3).
//
// The registry is a hand-curated literal. Twice now a command has been added to
// the CLI without a descriptor, and nobody noticed until a consumer needed it —
// `keryx modules --json` and the whole maintenance surface (`gdgraph build`,
// `wiki collect`, `test analyze`, …) were both discovered missing that way.
//
// Consumers treat the registry as exhaustive: the remote maintenance surface
// specified in docs/requirements/keryx-remote-entry projects it and refuses to
// invoke anything absent from it. A silent gap there is not a cosmetic problem —
// it is a command the operator cannot reach.
//
// So coverage is asserted, and every deliberate omission has to say why.

import { describe, expect, test } from "bun:test";
import { COMMAND_DESCRIPTORS, listDescriptors } from "./command-registry";

/**
 * Agent-facing commands intentionally kept out of the registry, each with the
 * reason it is excluded. A bare string is not accepted: an exclusion without a
 * reason is indistinguishable from an oversight, which is the failure mode this
 * whole test exists to prevent.
 */
const EXCLUSIONS: ReadonlyArray<{ command: string; reason: string }> = [
  { command: "shell", reason: "interactive TUI; owns the terminal and never returns a value" },
  { command: "sessions", reason: "interactive session browsing, scoped to the shell" },
  { command: "init", reason: "project lifecycle; scaffolds and rewrites the workspace" },
  { command: "update", reason: "toolkit lifecycle; replaces the installed runtime" },
  { command: "modules enable", reason: "mutates workspace scaffolding through init; not speculative" },
  { command: "modules disable", reason: "mutates workspace scaffolding through init; not speculative" },
  { command: "harness run", reason: "spends provider tokens on an arbitrary prompt; belongs to the agent surface" },
  { command: "harness exec", reason: "executes an arbitrary subprocess; gated by policy, never by a descriptor" },
  { command: "harness extension", reason: "executes a registered extension; same gating as harness exec" },
  { command: "harness wave", reason: "executes a bounded parallel wave; same gating as harness exec" },
  { command: "dashboard open", reason: "opens a browser; no machine-consumable result" },
  { command: "dash", reason: "alias of dashboard open" },
];

/**
 * The agent-facing command surface this guard checks. Kept as an explicit list
 * rather than parsed out of help text: help output is prose and would make the
 * guard fail for formatting reasons, which teaches people to disable it.
 */
const AGENT_FACING_COMMANDS: readonly string[] = [
  "status",
  "modules status",
  "gdgraph build",
  "gdgraph query",
  "gdgraph affected",
  "ctx status",
  "ctx rg",
  "wiki index",
  "wiki collect",
  "wiki check-links",
  "wiki enrich",
  "health run",
  "health explain",
  "memory search",
  "memory index",
  "memory reflect",
  "test run",
  "test analyze",
  "test status",
  "test suggest",
  "security scan",
  "flow list",
  "flow plan",
  "flow renumber",
  "agents monitor",
];

describe("command registry coverage", () => {
  test("every agent-facing command has a descriptor", () => {
    const described = new Set(COMMAND_DESCRIPTORS.map((descriptor) => descriptor.command));
    const missing = AGENT_FACING_COMMANDS.filter((command) => !described.has(command));
    expect(missing).toEqual([]);
  });

  test("every exclusion states a reason", () => {
    for (const exclusion of EXCLUSIONS) {
      expect(exclusion.command.length).toBeGreaterThan(0);
      expect(exclusion.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("an exclusion is never also described", () => {
    const described = new Set(COMMAND_DESCRIPTORS.map((descriptor) => descriptor.command));
    const contradictory = EXCLUSIONS.filter((exclusion) => described.has(exclusion.command));
    expect(contradictory.map((exclusion) => exclusion.command)).toEqual([]);
  });

  test("descriptors that write declare their side effects", () => {
    // `read: false` means the command mutates the workspace. A consumer that
    // gates writes behind an approval needs to be able to say what it is
    // approving, so a write with no stated effect is a defect.
    const writersWithoutEffects = COMMAND_DESCRIPTORS.filter(
      (descriptor) => descriptor.read === false && (descriptor.sideEffects ?? []).length === 0,
    );
    expect(writersWithoutEffects.map((descriptor) => descriptor.command)).toEqual([]);
  });

  test("no descriptor claims read-only while declaring side effects", () => {
    const lying = COMMAND_DESCRIPTORS.filter(
      (descriptor) => descriptor.read === true && (descriptor.sideEffects ?? []).length > 0,
    );
    expect(lying.map((descriptor) => descriptor.command)).toEqual([]);
  });

  test("every descriptor carries a summary, an intent phrase and an args array", () => {
    for (const descriptor of COMMAND_DESCRIPTORS) {
      expect(descriptor.summary.trim().length).toBeGreaterThan(0);
      expect(descriptor.intent.length).toBeGreaterThan(0);
      expect(Array.isArray(descriptor.args)).toBe(true);
    }
  });

  test("commands are unique", () => {
    const commands = COMMAND_DESCRIPTORS.map((descriptor) => descriptor.command);
    expect(commands.length).toBe(new Set(commands).size);
  });

  test("listDescriptors is sorted and stable across calls", () => {
    const first = listDescriptors().map((descriptor) => `${descriptor.module} ${descriptor.command}`);
    const second = listDescriptors().map((descriptor) => `${descriptor.module} ${descriptor.command}`);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });
});

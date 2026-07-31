// Coverage guard for the command descriptor registry (flow 087, item 3).
//
// The registry is a hand-curated literal, and twice a command reached the CLI
// without a descriptor. Consumers treat it as exhaustive: the remote
// maintenance surface specified in docs/requirements/keryx-remote-entry
// projects it and refuses to invoke anything absent from it, so a silent gap is
// a command the operator cannot reach.
//
// The first version of this guard compared the registry against a hand-written
// list of the same commands. That proves nothing — it compares two copies of
// one belief, and the regression it was written to stop still passed. The
// surface is therefore derived from `CLI_ROUTES`, the actual dispatch table:
// add a verb there and this fails until it is described or excluded WITH A
// REASON.
//
// Known limit, stated rather than hidden: this is verb-level. Subcommand
// parsing lives inside each handler, so a new `wiki <subcommand>` is not
// detected. It catches the failure that actually happened, not every possible
// one.

import { describe, expect, test } from "bun:test";
import { CLI_ROUTES } from "../cli";
import { COMMAND_DESCRIPTORS, isAutoAllowable, listDescriptors } from "./command-registry";

/**
 * Top-level verbs deliberately absent from the registry, each with the reason.
 * A bare string is not accepted: an exclusion without a reason is
 * indistinguishable from an oversight, which is the failure this file exists to
 * prevent.
 */
const EXCLUSIONS: ReadonlyArray<{ verb: string; reason: string }> = [
  { verb: "shell", reason: "interactive TUI; owns the terminal and returns no value" },
  { verb: "sessions", reason: "interactive session browsing, scoped to the shell" },
  { verb: "session", reason: "alias of sessions" },
  { verb: "init", reason: "project lifecycle; scaffolds and rewrites the workspace" },
  { verb: "update", reason: "toolkit lifecycle; replaces the installed runtime" },
  { verb: "harness", reason: "executes arbitrary subprocesses and spends provider tokens; gated by policy, never by a descriptor" },
  { verb: "dash", reason: "alias of dashboard open; opens a browser, no machine-consumable result" },
  { verb: "dashboard", reason: "build writes a human artifact and open launches a browser; neither is an agent operation" },
  { verb: "mcp", reason: "installs and serves an MCP endpoint; changes client configuration outside this project" },
  { verb: "sync", reason: "writes into external runtime directories outside the project" },
  { verb: "skills", reason: "skill lifecycle incl. install/export/sync writing outside the project; needs its own review before exposure" },
  { verb: "skill-verify-skill", reason: "standalone alias of skills verify; not part of the agent surface" },
  { verb: "rules", reason: "rewrites agent entrypoint rule files; lifecycle, not an operation" },
  { verb: "standard", reason: "conformance tooling for the Metaproject Standard, aimed at maintainers" },
  { verb: "review", reason: "managed review package lifecycle; stateful multi-step, not a single callable operation" },
  { verb: "orient", reason: "emits or installs an orientation block into agent entrypoints; lifecycle" },
  { verb: "metrics", reason: "execution-metrics tooling aimed at maintainers and CI, not agents" },
  { verb: "commands", reason: "the registry surface itself; describing it in itself adds nothing" },
];

/** Verbs that carry at least one descriptor, derived from the registry. */
function describedVerbs(): Set<string> {
  const verbs = new Set<string>();
  for (const descriptor of COMMAND_DESCRIPTORS) {
    verbs.add(descriptor.command.split(" ")[0]!);
  }
  return verbs;
}

describe("command registry coverage", () => {
  test("every CLI verb is either described or excluded with a reason", () => {
    const described = describedVerbs();
    const excluded = new Set(EXCLUSIONS.map((exclusion) => exclusion.verb));
    const unclassified = Object.keys(CLI_ROUTES)
      .filter((verb) => !described.has(verb) && !excluded.has(verb))
      .sort();
    expect(unclassified).toEqual([]);
  });

  test("every exclusion states a reason", () => {
    for (const exclusion of EXCLUSIONS) {
      expect(exclusion.verb.length).toBeGreaterThan(0);
      expect(exclusion.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("every exclusion names a verb the CLI actually dispatches", () => {
    // Otherwise the list rots into reasons for commands that no longer exist,
    // and a real verb can hide behind a stale entry.
    const stale = EXCLUSIONS.filter((exclusion) => !(exclusion.verb in CLI_ROUTES)).map((e) => e.verb);
    expect(stale).toEqual([]);
  });

  test("an excluded verb is never also described", () => {
    const described = describedVerbs();
    const contradictory = EXCLUSIONS.filter((exclusion) => described.has(exclusion.verb)).map((e) => e.verb);
    expect(contradictory).toEqual([]);
  });

  test("every described command belongs to a verb the CLI dispatches", () => {
    const unreachable = COMMAND_DESCRIPTORS.filter(
      (descriptor) => !(descriptor.command.split(" ")[0]! in CLI_ROUTES),
    ).map((descriptor) => descriptor.command);
    expect(unreachable).toEqual([]);
  });

  test("descriptors that write declare their side effects", () => {
    // `read: false` means the command mutates. A consumer gating writes behind
    // an approval must be able to say what it is approving.
    const silentWriters = COMMAND_DESCRIPTORS.filter(
      (descriptor) => descriptor.read === false && (descriptor.sideEffects ?? []).length === 0,
    ).map((descriptor) => descriptor.command);
    expect(silentWriters).toEqual([]);
  });

  test("no descriptor claims read-only while declaring side effects", () => {
    const lying = COMMAND_DESCRIPTORS.filter(
      (descriptor) => descriptor.read === true && (descriptor.sideEffects ?? []).length > 0,
    ).map((descriptor) => descriptor.command);
    expect(lying).toEqual([]);
  });

  test("a model-backed command is never auto-allowable", () => {
    // `read` answers "does it write", not "is it free". A command that spends
    // provider tokens and makes an outbound call with the operator's credential
    // is something they are entitled to approve even when nothing is written.
    const spendsSilently = COMMAND_DESCRIPTORS.filter(
      (descriptor) => descriptor.model === true && isAutoAllowable(descriptor),
    ).map((descriptor) => descriptor.command);
    expect(spendsSilently).toEqual([]);
  });

  test("commands are unique", () => {
    const commands = COMMAND_DESCRIPTORS.map((descriptor) => descriptor.command);
    expect(commands.length).toBe(new Set(commands).size);
  });

  test("listDescriptors filters to a module without losing entries", () => {
    const core = listDescriptors("core").map((descriptor) => descriptor.command);
    expect(core).toEqual([
      "modules status",
      "projects forget",
      "projects list",
      "projects register",
      "status",
    ]);
  });
});

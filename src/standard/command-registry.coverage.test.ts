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

import path from "node:path";
import { describe, expect, test } from "bun:test";
import { CLI_ROUTES } from "../cli";
import { triggerCommand } from "../commands/trigger";
import { dispatchLockPath } from "../commands/trigger-dispatch";
import { maintenanceLockPath } from "../lib/maintenance-lock";
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
  {
    verb: "serve",
    reason:
      "binds a network socket and runs until signalled, like shell and harness; its token subcommands mint and invalidate a credential. Neither shape is a single callable operation with a machine-consumable result, and a descriptor would advertise the credential surface to exactly the agents that must not reach it",
  },
  { verb: "dash", reason: "alias of dashboard open; opens a browser, no machine-consumable result" },
  { verb: "dashboard", reason: "build writes a human artifact and open launches a browser; neither is an agent operation" },
  {
    verb: "serve-mcp",
    reason:
      "binds a transport and runs until signalled, like serve and shell; under stdio it owns stdout as a JSON-RPC channel, so it has no machine-consumable result a descriptor could describe",
  },
  {
    verb: "integrate",
    reason:
      "writes MCP client configuration into editor/agent files outside this project's managed surface — the same reason `mcp`, whose spelling it replaces, is excluded",
  },
  { verb: "mcp", reason: "retired spelling of serve-mcp and integrate; excluded for the same reasons as both" },
  {
    verb: "integrations",
    reason:
      "install/uninstall can remove the agent's own guard hooks (its ctx-guard/security block), so the verb must not be agent-invocable — the exclusion is at the VERB level, not per-subcommand, so read-only subcommands (doctor, matrix) are excluded alongside install/uninstall rather than carved out",
  },
  { verb: "sync", reason: "writes into external runtime directories outside the project" },
  { verb: "skills", reason: "skill lifecycle incl. install/export/sync writing outside the project; needs its own review before exposure" },
  { verb: "skill-verify-skill", reason: "standalone alias of skills verify; not part of the agent surface" },
  { verb: "rules", reason: "rewrites agent entrypoint rule files; lifecycle, not an operation" },
  { verb: "standard", reason: "conformance tooling for the Metaproject Standard, aimed at maintainers" },
  { verb: "review", reason: "managed review package lifecycle; stateful multi-step, not a single callable operation" },
  { verb: "orient", reason: "emits or installs an orientation block into agent entrypoints; lifecycle" },
  { verb: "metrics", reason: "execution-metrics tooling aimed at maintainers and CI, not agents" },
  { verb: "commands", reason: "the registry surface itself; describing it in itself adds nothing" },
  { verb: "workspace", reason: "offline SAC registry mutation is intentionally local-CLI only in Phase 1; exposing a descriptor would make it eligible for future remote/MCP projection before that security boundary exists" },
  {
    verb: "acp",
    reason:
      "binds stdio as a JSON-RPC channel and runs until signalled, like serve-mcp and shell; it owns stdout as the protocol wire, so it has no machine-consumable result a descriptor could describe",
  },
  {
    verb: "stack",
    reason:
      "flow 309 (W1 Lane A): brand-new verb, deterministic local detection only (writes .metaproject/data/stack/stack.json, no external side effect) — a descriptor is deferred to the W1 install-manifest lane (Lane B) that will actually consume stack.json, rather than exposed ahead of that wiring",
  },
  {
    verb: "__sandbox-net-forward",
    reason:
      "internal helper keryx starts inside an unattended sandbox to bridge a local port to the allowlist proxy's socket; it runs until the sandboxed command ends and is never an operation for an agent to call",
  },
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
      "help",
      "modules status",
      "projects forget",
      "projects list",
      "projects register",
      "status",
      "version check",
    ]);
  });
});

// AC3 (flow 294): the `trigger run` descriptor once claimed "open-flow"/
// "flow-next" refuse cleanly and named a `.run.lock` path neither is true of
// this build any more (flows 286/290 made both actions run, and flow-next
// with a "dispatch" block DISPATCHES an agent; the lock moved to
// `.metaproject/data/.locks/`). Nothing caught that drift because the
// descriptor and the CLI's own help text are two independent copies of the
// same belief. This test pins the descriptor against `keryx trigger`'s own
// help text — the actual behaviour, as `triggerCommand` states it — so the
// two cannot drift apart again unnoticed.
describe("trigger run descriptor pinned against the trigger help", () => {
  async function captureTriggerHelp(): Promise<string> {
    const lines: string[] = [];
    const original = console.log;
    console.log = ((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    }) as typeof console.log;
    try {
      await triggerCommand(["--help"]);
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  test("the help itself no longer claims open-flow/flow-next refuse, and describes dispatch", async () => {
    const help = await captureTriggerHelp();
    // Sanity on the pin's own premise: if the CLI's help stopped saying
    // flow-next dispatches, or started claiming a clean refusal again, that
    // is a real behaviour change the descriptor would then have to follow —
    // not a false positive in this test.
    expect(help).toContain("DISPATCHES a keryx agent");
    expect(help).not.toMatch(/open-flow[^.]*flow-next[^.]*refuse/i);
    expect(help).not.toContain(".metaproject/data/trigger/.run.lock");
  });

  test("the descriptor matches: no refusal claim, no stale lock path, and it mentions dispatch", () => {
    const descriptor = COMMAND_DESCRIPTORS.find((entry) => entry.command === "trigger run");
    expect(descriptor).toBeDefined();
    const text = `${descriptor!.summary} ${(descriptor!.sideEffects ?? []).join(" ")}`;
    expect(text).not.toMatch(/open-flow[^.]*flow-next[^.]*refuse/i);
    expect(text).not.toContain(".metaproject/data/trigger/.run.lock");
    expect(text.toLowerCase()).toContain("dispatch");
  });

  // Review of PR #658 caught a second false claim the tests above did not:
  // the descriptor said EVERY action "briefly holds the project's shared
  // maintenance lock … refuses when another run holds it". True for
  // reconcile/rebuild/open-flow (`withTriggerRunLock` -> `withMaintenanceLock`
  // in trigger.ts), but FALSE for a dispatching `flow-next`:
  // `runFlowNextDispatch` (trigger-dispatch.ts) takes a PER-FLOW
  // `dispatch-<flow>.lock` for the dispatch, and only briefly a separate
  // `spend.lock` for the reservation — its own top-of-file comment says so
  // outright ("The project's MAINTENANCE lock is not held across the agent
  // run: the agent's own `keryx gdgraph build` must be able to take it"), so
  // two dispatches on DIFFERENT flows run concurrently. Pinned against the
  // real exported lock-path functions, not against a second hand-written
  // string, so a rename of either lock file fails this instead of the
  // descriptor silently going stale again.
  test("the descriptor's lock claim is split per action: reconcile/rebuild/open-flow name the shared maintenance lock, a dispatching flow-next names the per-flow dispatch lock instead", () => {
    const descriptor = COMMAND_DESCRIPTORS.find((entry) => entry.command === "trigger run");
    expect(descriptor).toBeDefined();
    const sideEffects = descriptor!.sideEffects ?? [];

    const maintenanceLockName = path.basename(maintenanceLockPath("/tmp/keryx-pin-test"));
    const dispatchLockName = path.basename(dispatchLockPath("/tmp/keryx-pin-test", "142"));
    expect(maintenanceLockName).toBe("maintenance.lock");
    expect(dispatchLockName).toBe("dispatch-142.lock");

    const reconcileEffect = sideEffects.find((line) => line.startsWith("reconcile:"));
    const rebuildEffect = sideEffects.find((line) => line.startsWith("rebuild:"));
    const openFlowEffect = sideEffects.find((line) => line.startsWith("open-flow:"));
    for (const effect of [reconcileEffect, rebuildEffect, openFlowEffect]) {
      expect(effect).toBeDefined();
      expect(effect).toContain(maintenanceLockName);
    }

    const dispatchEffect = sideEffects.find(
      (line) => /flow-next/i.test(line) && /dispatch block/i.test(line) && !/no dispatch block/i.test(line),
    );
    expect(dispatchEffect).toBeDefined();
    // Names the real per-flow lock (derived above from the actual export)...
    expect(dispatchEffect).toContain("dispatch-<flow>.lock");
    // ...and must NOT claim it takes (or refuses via) the shared maintenance
    // lock — the exact false claim this test exists to catch.
    expect(dispatchEffect).not.toContain(maintenanceLockName);
    expect(dispatchEffect?.toLowerCase()).not.toMatch(/refuses[^.]*when another run[^.]*holds/);
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { initCommand } from "./init";
import { MODULE_COMMANDS, type ModuleId } from "./module-commands";

// Guards the F-001 blocker: the generated manifest must never advertise a
// subcommand that the CLI does not dispatch. init reads MODULE_COMMANDS, so a
// stray inline array (e.g. gdgraph "explain"/"path") would fail here.
test("init writes module command lists from the canonical source of truth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-cmds-"));

  try {
    await withCwd(root, async () => {
    await initCommand(["--yes"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled?: boolean; commands?: string[] }>;
    };

    // `sac` is in MODULE_COMMANDS but is NOT one of the nine modules `init`
    // enables — its manifest entry is written only once `keryx modules enable
    // sac` (or an explicit opt-in) turns it on, so a default init leaves it
    // `{ enabled: false }` with no `commands`. Asserting `enabled === true`
    // for it here would be asserting the wrong thing about a real behaviour.
    for (const id of (Object.keys(MODULE_COMMANDS) as ModuleId[]).filter((id) => id !== "sac")) {
      const mod = manifest.modules[id];
      expect(mod?.enabled).toBe(true);
      expect(mod?.commands).toEqual([...MODULE_COMMANDS[id]]);
    }
    expect(manifest.modules.sac?.enabled).toBe(false);

    // Explicit regression assertions for the drift that motivated this fix.
    expect(manifest.modules.gdgraph?.commands).not.toContain("explain");
    expect(manifest.modules.gdgraph?.commands).not.toContain("path");
    expect(manifest.modules.gdwiki?.commands).toContain("collect");
    expect(manifest.modules.gdskills?.commands).toContain("contracts");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The canonical map must not reintroduce the removed gdgraph commands
// (explain/path) and must advertise exactly the implemented surface. `repomap`
// was added by Block B (ranked repo map); it is a real, always-available
// subcommand dispatched by src/commands/gdgraph.ts.
test("MODULE_COMMANDS matches the implemented gdgraph surface", () => {
  expect([...MODULE_COMMANDS.gdgraph]).toEqual(["build", "query", "affected", "repomap"]);
});

// `sac` is the one entry whose CLI namespace (`workspace`) does not match its
// module id, so no `src/commands/sac.ts` exists to compare against by name. It
// spent its whole life as two hand-written copies — one in init.ts, one in
// update.ts — and both had drifted to ten of the sixteen subcommands the
// router dispatches, which is exactly what a hand-maintained list does.
//
// So this derives the expectation from `workspace.ts`'s own dispatch rather
// than restating it: a `subcommand === "x"` comparison IS the routing
// decision, and a subcommand that stops being dispatched stops matching. A
// hand-written expected-array here would only be a third copy to drift.
test("MODULE_COMMANDS.sac matches every subcommand workspace.ts dispatches", async () => {
  const source = await readFile(new URL("./workspace.ts", import.meta.url), "utf8");

  const dispatched = new Set<string>();
  for (const match of source.matchAll(/subcommand === "([a-z][a-z-]*)"/g)) {
    const name = match[1];
    // `help` is the usage banner, not a routed subcommand, and is deliberately
    // absent from every other module's list too.
    if (name !== undefined && name !== "help") dispatched.add(name);
  }

  // Guards the scrape itself: if the dispatch style is ever refactored (a
  // switch, a lookup table) this regex silently matches nothing, and a test
  // asserting "the empty set equals the empty set" would pass while checking
  // nothing at all.
  expect(dispatched.size).toBeGreaterThan(10);

  const declared: string[] = [...MODULE_COMMANDS.sac];
  expect(declared.sort()).toEqual([...dispatched].sort());
});

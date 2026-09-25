import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { CLI_ROUTES, exitCodeForError, groupUsage, helpRequestedFor, shouldInterceptHelp } from "./cli";
import { ShellFlagError, shellCommand } from "./commands/shell";

// RED tests for flow 021 (interactive `keryx` shell), T5 / AC3.
//
// `keryx --help`/`-h` must list `keryx harness run …` (already dispatched in
// `src/cli.ts` but not yet present in `printHelp()`'s printed text) AND the
// interactive shell — this is a behavioral, offline spawn test (no stdin is
// read for `--help`).
//
// Bare `keryx` (no args) is the CLI surface and must print usage — NOT launch
// the interactive shell. The TUI agent harness is only `keryx shell […]`.

test("--help lists the harness command and the interactive shell", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "--help"]);

  expect(output).toMatch(/keryx harness run/);
  expect(/shell|interactive/i.test(output)).toBe(true);
});

test("bare `keryx` (no args) prints CLI usage, not the shell", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath]);

  expect(output).toMatch(/Usage:/);
  expect(output).toMatch(/keryx shell/);
  expect(output).not.toMatch(/Select a provider/);
});

test("`keryx shell` is dispatched via shellCommand, and bare `keryx` is not", () => {
  // Flow 021 / AC3. This used to grep cli.ts for `if (command === "shell")`,
  // which was a proxy for the real invariant: the verb `shell` reaches
  // `shellCommand`, and the no-args path prints help instead of entering the
  // shell. Dispatch is now a table, so the binding itself can be asserted —
  // strictly stronger than matching the source text, which passed for any
  // spelling and would keep passing if the handler were swapped.
  expect(Object.keys(CLI_ROUTES)).toContain("shell");
  expect(CLI_ROUTES.shell).toBe(shellCommand);
  expect(CLI_ROUTES[""]).toBeUndefined();

  const cliSource = readFileSync(path.join(import.meta.dir, "cli.ts"), "utf8");
  expect(cliSource).toMatch(/!command/);
  expect(cliSource).toMatch(/printHelp\(\)/);
});

test("dash alias is advertised in CLI help", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "--help"]);

  expect(output).toContain("keryx dash");
  expect(output).toContain("dash      Rebuild and open .metaproject/keryx-dashboard.html");
});

test("flow 303 AC5: --help, -h and bare `keryx` print the identical flat usage, and `keryx help` (grouped) differs from all three", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const [helpFlag, hFlag, bare, grouped] = await Promise.all([
    runBun([cliPath, "--help"]),
    runBun([cliPath, "-h"]),
    runBun([cliPath]),
    runBun([cliPath, "help"]),
  ]);
  expect(helpFlag).toBe(hFlag);
  expect(helpFlag).toBe(bare);
  expect(grouped).not.toBe(helpFlag);
  expect(grouped).toMatch(/Start here:/);
  expect(grouped).toMatch(/Maintenance and diagnostics:/);
});

// PR #669 review, MEDIUM (AC5, amended): comparing the three flat forms to
// EACH OTHER (above) proves they agree with one another, but not that any of
// them still says what they said before this flow — a bug that changed all
// three identically would sail through unnoticed. These pin the flat block
// against a fixture captured by actually RUNNING `src/cli.ts` at commit
// 0d6ac030 (the last main commit before flow 303, per the operator) —
// `fixtures/cli-help-pre-flow-303/*.txt` — so the comparison is against real
// captured stdout, not a hand-transcribed copy that could itself drift.
describe("flow 303 AC5 (amended): flat usage and the four rich helps, pinned against their pre-flow output", () => {
  const FIXTURES_ROOT = path.join(import.meta.dir, "../fixtures/cli-help-pre-flow-303");

  // The ONLY lines these flows are allowed to have added to the flat
  // block. Flow 303: one in USAGE_BODY, one in the Commands: summary table.
  // Flow 304 (review finding #5): `keryx --help` never listed the new
  // `providers test`/`providers remove` subcommands — both added here, in
  // USAGE_BODY only (they are subcommands of an existing verb, so no new
  // Commands: summary row is needed, unlike flow 303's brand-new `help` verb).
  // Flow 307 (W5-b): brand-new `integrations` verb, same shape as flow 303's
  // `help` — one USAGE_BODY line per subcommand (it has four: install,
  // uninstall, doctor, matrix) plus one Commands: summary row.
  const NEW_LINES = [
    "  keryx help [group|command]                   Grouped command help by task (--help/-h keep this flat usage)\n",
    "  help      Grouped command help by task: every verb, in nine onboarding-ordered groups\n",
    "  keryx providers test <name> [--json]\n",
    "  keryx providers remove <name> [--yes] [--json]\n",
    "  keryx integrations install --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]\n",
    "  keryx integrations uninstall --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--dry-run] [--json]\n",
    "  keryx integrations doctor --runtime <id>[,<id>...|all] [--surface <flag|id>]... [--json]\n",
    "  keryx integrations matrix [--check] [--write] [--json] [--file <path>]\n",
    "  integrations Install/uninstall/audit Keryx's hooks and instructions in another coding agent, and the generated capability matrix\n",
    // Flow 309 (W1 Lane A): brand-new `stack` verb — one USAGE_BODY line plus
    // one Commands: summary row, same shape as flow 307's `integrations`.
    "  keryx stack detect [--cwd <dir>] [--json] [--no-write]\n",
    "  stack     Deterministic, offline stack detection (keryx stack detect)\n",
    // Flow 306 (W6, T8): the new `keryx hooks` verb — five USAGE_BODY lines
    // (one wraps onto a continuation line) plus its Commands: summary row.
    "  keryx hooks list [--json]                     Resolved keryx shell lifecycle hooks (built-in -> user -> project)\n",
    "  keryx hooks validate [--json] [--ci]          Validate .metaproject/hooks.json and ~/.keryx/hooks.json\n",
    "  keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]\n",
    "                                               Run one hook once against a synthetic or captured payload\n",
    "  keryx hooks enable <id> [--user]              Flip a hook's enabled state (project file, or --user for ~/.keryx/hooks.json)\n",
    "  keryx hooks trust [--yes]                     Show every command in .metaproject/hooks.json and trust exactly that version\n",
    "  keryx hooks untrust                           Withdraw trust; project command hooks stop running\n",
    "  keryx hooks disable <id> [--user] [--acknowledge-gate-risk]\n",
    "  hooks     Keryx shell lifecycle hooks: list/validate/test, trust project hooks, enable/disable a registration\n",
    // Flow 313 (W4 portability, T10): the new `keryx bundle` verb — seven
    // USAGE_BODY lines plus its Commands: summary row.
    "  keryx bundle export --scope <project|team|user> [--include <glob>]... [--kind <k,...>] [--id <id>] [--target-harness <h,...>] <out> [--json]\n",
    "  keryx bundle import <bundle> [--target-scope <scope>] [--render-for <h,...>] [--force <path>]... [--allow-hooks] [--dry-run] [--json]\n",
    "  keryx bundle import <catalog-dir> --external [--dry-run] [--json]\n",
    "  keryx bundle inspect <bundle> [--target-scope <scope>] [--json]\n",
    "  keryx bundle verify <bundle> [--json]\n",
    "  keryx bundle verify --external-imports [--json]\n",
    "  keryx bundle uninstall <bundleId> --target-scope <scope> [--dry-run] [--json]\n",
    "  bundle    Portable bundle export/import of skills, rules, agents, memory and hooks across scopes and harnesses\n",
    // Flow 312 (W3, T8): the new `keryx learn` verb — eleven USAGE_BODY lines
    // (three wrap onto a continuation line) plus its Commands: summary row.
    "  keryx learn observe [--hook claude]           Flush pending observations, or adapt one host-hook payload\n",
    "  keryx learn extract [--domain <d>] [--since <date>] [--json]\n",
    "                                               Run deterministic signals over the observation window\n",
    "  keryx learn list [--status <s>] [--domain <d>] [--scope <s>] [--json]\n",
    "  keryx learn review [<id>] [--scope <s>]       Print a candidate (or all candidates) with its evidence\n",
    "  keryx learn accept <id> [--scope user] [--refresh]\n",
    "                                               candidate -> accepted; TTY only, no bypass flag\n",
    "  keryx learn reject <id> [--scope user]\n",
    "  keryx learn apply <id> --skill <module/name> [--dry-run]\n",
    "  keryx learn promote <id>                      project accepted -> user candidate; TTY + typed confirm\n",
    "  keryx learn graduate [--domain <d>] | graduate apply <proposal-id>\n",
    "  keryx learn prune [--dry-run] [--json]\n",
    "  learn     Self-learning loop: observe, extract, review, accept/reject, apply, promote, graduate, prune\n",
    // Flow 309: `keryx providers status` — the live provider catalog (model
    // list + balance per connected provider, `/routing`'s picker and
    // `/connect` now read the same cache). A subcommand of an existing verb,
    // so USAGE_BODY only — same shape as flow 304's `test`/`remove` above.
    "  keryx providers status [--json] [--refresh]\n",
    // Flow 305: the routing table (category -> model), `keryx routing`, plus
    // its summary row — a brand-new verb, so both a USAGE_BODY block and a
    // Commands: summary row were added (mirrors flow 303's `help`, not flow
    // 304's `providers test`/`remove`, which were subcommands of an existing
    // verb and needed only the USAGE_BODY lines).
    "  keryx routing list [--json]\n",
    "  keryx routing set <category> <provider>/<model> [--user|--project]\n",
    "  keryx routing set <category> <provider> [--user|--project]\n",
    "  keryx routing unset <category> [--user|--project]\n",
    // Flow 305 review finding (AC11): `keryx routing trust` — approve a
    // project routing.config.json's current content.
    "  keryx routing trust\n",
    "  routing   Category -> model routing table: list, set, unset (per-user default; --project for the project layer)\n",
  ];

  // R700-09: lines the pre-flow fixture already had, whose TEXT changed
  // (rather than a brand-new line being added) — `NEW_LINES` above only
  // handles pure additions, so a changed line is instead named here as
  // [oldLine, newLine]: the test asserts the new text is present, then
  // substitutes the OLD text back in before comparing against the immutable
  // pre-flow-303 capture, which still carries the original wording.
  const REPLACED_LINES: ReadonlyArray<readonly [string, string]> = [
    [
      "  agents    Manage optional global agent bootstrap instructions\n",
      "  agents    Manage optional global agent bootstrap instructions, and the agent catalog (list/show/export/verify/generate)\n",
    ],
  ];

  test("the flat --help block is the pre-flow fixture plus exactly those lines, nothing else", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const current = await runBun([cliPath, "--help"]);
    const preFlow = readFileSync(path.join(FIXTURES_ROOT, "flat-help.txt"), "utf8");

    let reconstructed = current;
    for (const line of NEW_LINES) {
      expect(reconstructed).toContain(line);
      reconstructed = reconstructed.replace(line, "");
    }
    for (const [oldLine, newLine] of REPLACED_LINES) {
      expect(reconstructed).toContain(newLine);
      reconstructed = reconstructed.replace(newLine, oldLine);
    }
    // The banner's version moves with every release; the block under it is what AC5 pins.
    const withoutVersion = (text: string): string => text.replace(/^keryx \S+\n/, "keryx <version>\n");
    expect(withoutVersion(reconstructed)).toBe(withoutVersion(preFlow));
  });

  // The ONLY lines later flows may add to a rich help. Flow 313 (W4, T8):
  // `serve-mcp --harness` binds the cross-harness memory identity at launch —
  // one synopsis line and one flag line.
  const RICH_NEW_LINES: Readonly<Record<string, readonly string[]>> = {
    "serve-mcp": [
      "  keryx serve-mcp --harness <id> [--cwd <project-root>]  # bind a cross-harness memory identity\n",
      "  --harness    Bind this server process's cross-harness memory identity once at launch (or set KERYX_HARNESS; --harness wins). Used by memory.search filtering, memory.handoff, and the Source-Harness stamped on memory.propose writes. Unknown id refuses to start.\n",
    ],
  };

  test.each(["flow", "trigger", "serve-mcp", "governance"] as const)(
    "the rich `%s --help` output is its pre-flow fixture plus exactly the allowed added lines",
    async (verb) => {
      const cliPath = path.join(import.meta.dir, "cli.ts");
      const current = await runBun([cliPath, verb, "--help"]);
      const preFlow = readFileSync(path.join(FIXTURES_ROOT, `${verb}-help.txt`), "utf8");
      let reconstructed = current;
      for (const line of RICH_NEW_LINES[verb] ?? []) {
        expect(reconstructed).toContain(line);
        reconstructed = reconstructed.replace(line, "");
      }
      expect(reconstructed).toBe(preFlow);
    },
  );
});

test("agents bootstrap help is available without touching global files", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "agents", "bootstrap", "--help"]);

  expect(output).toContain("keryx agents bootstrap");
  expect(output).toContain("claude, opencode, zcode, codex, antigravity");
  expect(output).toContain("--dry-run");
});

function runBun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `bun exited with ${code}`));
    });
  });
}

test("only a ShellFlagError sets its own exit code; any other error exits 1 (review F9)", () => {
  expect(exitCodeForError(new ShellFlagError("--fork needs an explicit session id"))).toBe(2);
  // A child-process error (Bun ShellError, execa) carries the CHILD's code.
  expect(exitCodeForError(Object.assign(new Error("child failed"), { exitCode: 7 }))).toBe(1);
  expect(exitCodeForError({ exitCode: 3 })).toBe(1);
  expect(exitCodeForError("boom")).toBe(1);
  expect(exitCodeForError(null)).toBe(1);
});

// --- `--help` is a QUESTION, never a command (found the hard way: running
// `keryx skills install --help` to read its usage INSTALLED 52 skills, because
// `--help` was recognized only as the first argv token) ---

test("a `--help` after a subcommand is recognized as a question", () => {
  expect(helpRequestedFor(["install", "--help"])).toBe(true);
  expect(helpRequestedFor(["install", "-h"])).toBe(true);
  expect(helpRequestedFor(["install"])).toBe(false);
  // A CHILD's own flag, after the separator, must pass through untouched:
  // `harness exec -- <cmd> --help` asks the child for help, and the harness
  // still has to run it.
  expect(helpRequestedFor(["exec", "--", "cmd", "--help"])).toBe(false);
  expect(helpRequestedFor(["--", "--help"])).toBe(false);
});

test("a group's usage is its own lines — including the indented descriptions that belong to them", () => {
  const skills = groupUsage("skills");
  expect(skills).toContain("keryx skills install [--profile recommended]");
  expect(skills).toContain("keryx skills sync --runtime codex|claude --target <dir>");
  expect(skills).not.toContain("keryx flow init");

  const sessions = groupUsage("sessions");
  expect(sessions).toContain("keryx sessions list|fork <id>|export <id>|path");
  expect(sessions).toContain("List / branch / export sessions for the current project");

  expect(groupUsage("not-a-command")).toBeUndefined();
});

test("the guard defers to a group that answers `--help` deeper, and passes a child's flag through", () => {
  expect(shouldInterceptHelp("skills", ["install", "--help"])).toBe(true);
  expect(shouldInterceptHelp("flow", ["complete", "--help"])).toBe(true);
  // `agents bootstrap --help` is answered by the bootstrap handler, which knows
  // the runtime list this group's two usage lines do not carry.
  expect(shouldInterceptHelp("agents", ["bootstrap", "--help"])).toBe(false);
  // After the separator the flag is the child process's, not ours.
  expect(shouldInterceptHelp("harness", ["exec", "--", "cmd", "--help"])).toBe(false);
});

// R700-07: `skills`/`memory`/`security` `--help`, and `--help` on the
// specific subcommands whose own handler already guards it safely, must
// reach the real handler instead of the generic `groupUsage` slice — every
// OTHER subcommand of these three verbs (e.g. `skills install`, `memory
// new`) must keep going through the interception guard, since most do not
// check `--help` at all and some (`skills install`) write files.
test("skills/memory/security --help defers to the real handler for the bare verb and the listed safe subcommands", () => {
  expect(shouldInterceptHelp("skills", ["--help"])).toBe(false);
  expect(shouldInterceptHelp("memory", ["--help"])).toBe(false);
  expect(shouldInterceptHelp("security", ["--help"])).toBe(false);

  expect(shouldInterceptHelp("skills", ["doctor", "--help"])).toBe(false);
  expect(shouldInterceptHelp("skills", ["uninstall", "--help"])).toBe(false);
  expect(shouldInterceptHelp("skills", ["scout", "--help"])).toBe(false);
  expect(shouldInterceptHelp("skills", ["eval", "--help"])).toBe(false);
  expect(shouldInterceptHelp("skills", ["judge-check", "--help"])).toBe(false);
  expect(shouldInterceptHelp("skills", ["stocktake", "--help"])).toBe(false);
  expect(shouldInterceptHelp("memory", ["handoff", "--help"])).toBe(false);
  expect(shouldInterceptHelp("security", ["audit-harness", "--help"])).toBe(false);
  expect(shouldInterceptHelp("security", ["impact-evidence", "--help"])).toBe(false);

  // Every other subcommand of these three verbs is unaffected — still
  // intercepted, exactly as before this fix.
  expect(shouldInterceptHelp("skills", ["install", "--help"])).toBe(true);
  expect(shouldInterceptHelp("skills", ["catalog", "--help"])).toBe(true);
  expect(shouldInterceptHelp("memory", ["new", "--help"])).toBe(true);
  expect(shouldInterceptHelp("memory", ["search", "--help"])).toBe(true);
  expect(shouldInterceptHelp("security", ["scan", "--help"])).toBe(true);
});

test("every dispatched group either has its own usage lines or falls back to the full help", () => {
  const missing = Object.keys(CLI_ROUTES).filter((name) => groupUsage(name) === undefined);
  // `session` is the singular ALIAS of `sessions` (`CLI_ROUTES.session ===
  // sessionsCommand`), and the usage block lists the canonical spelling only —
  // so it is one route answered by the full-help fallback.
  // `__sandbox-net-forward` (flow 301, AC5) is `planUnattendedSandbox.wrap()`'s hidden
  // internal helper — no operator ever types it, so it has no usage lines to give, and
  // none belong in `USAGE_BODY` (that would defeat "hidden"). Both are named here, on
  // purpose, so a THIRD undocumented route still fails this pin rather than growing
  // the exception list unwatched.
  expect(missing.sort()).toEqual(["__sandbox-net-forward", "session"]);
});

// AC5 (flow 294): `keryx flow --help` (and trigger/governance/agents external)
// used to be intercepted into a slice of the static `USAGE_BODY` that had
// already drifted from the handler's own dispatch table — `flow` was missing
// `owner`/`ac`/`freeze`/`start`/`next`/`task`/… entirely, `trigger` was
// missing every subcommand but `run`. `src/cli.ts` now routes these groups'
// `--help` to the handler's own help function (still fully intercepted, so a
// stray `--help` after a mutating subcommand like `trigger install` still
// cannot run it — see the guard test above). This derives the "must appear"
// set from each handler's actual dispatch table, SOURCE rather than a second
// hand-written list, so a new subcommand that forgets to update its own help
// text fails here rather than shipping silently missing.
describe("AC5: a group's top-level --help lists every subcommand its handler dispatches", () => {
  /**
   * The substring of `source` inside the FIRST `switch (${switchVar}) { … }`,
   * brace-matched rather than regex-matched to its close — both `flow.ts` and
   * `trigger.ts` have unrelated inner `switch`es on a result's `.kind`
   * (`resume.kind`, `resolution.kind`) whose case labels (`"ended"`,
   * `"config-absent"`, …) are not subcommands, and a regex with no brace
   * awareness cannot tell those apart from the dispatch switch.
   */
  function switchBody(source: string, switchVar: string): string {
    const header = `switch (${switchVar}) {`;
    const headerAt = source.indexOf(header);
    if (headerAt < 0) return "";
    let depth = 0;
    let i = source.indexOf("{", headerAt);
    const bodyStart = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return source.slice(bodyStart, i + 1);
  }

  /** Same brace-matching, keyed to a named `function <name>(…) { … }` instead of a `switch`. */
  function functionBody(source: string, name: string): string {
    const headerAt = source.search(new RegExp(`function ${name}\\(`));
    if (headerAt < 0) return "";
    let depth = 0;
    let i = source.indexOf("{", headerAt);
    const bodyStart = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return source.slice(bodyStart, i + 1);
  }

  // `flow`'s outer case names that are themselves dispatched one level
  // deeper, by their own `run<Outer>` function keyed on `sub` — "owner set",
  // "ac confirm/update/reseal", "task add/done/attempt/depends". Expanded to
  // the two-word phrase below, because a bare inner token like "set" or "add"
  // is common English: it would still be found in unrelated prose (`--owner`,
  // "can all be set by an agent") even with the whole nested usage LINE
  // deleted, which is exactly the false negative a first draft of this test had.
  const NESTED_DISPATCH: Readonly<Record<string, string>> = { owner: "runOwner", ac: "runAc", task: "runTask" };

  /** `case "x":` (within the given switch body, if any) and `<command-var> === "x"` (anywhere, for non-switch dispatch). */
  function dispatchedNames(source: string, switchVar?: string): Set<string> {
    const names = new Set<string>();
    const caseScope = switchVar ? switchBody(source, switchVar) : source;
    const outer = new Set<string>();
    for (const match of caseScope.matchAll(/\bcase "([a-z][a-z0-9-]*)":/g)) {
      outer.add(match[1] as string);
    }
    for (const outerName of outer) {
      names.add(outerName);
      const nestedFn = NESTED_DISPATCH[outerName];
      if (nestedFn === undefined) continue;
      for (const match of functionBody(source, nestedFn).matchAll(/\bsub === "([a-z][a-z0-9-]*)"/g)) {
        names.add(`${outerName} ${match[1]}`);
      }
    }
    if (!switchVar) {
      for (const match of source.matchAll(/\b(?:command|subcommand) === "([a-z][a-z0-9-]*)"/g)) {
        names.add(match[1] as string);
      }
    }
    names.delete("help");
    return names;
  }

  const dispatchCases: ReadonlyArray<{ group: string; file: string; switchVar?: string }> = [
    { group: "flow", file: "commands/flow.ts", switchVar: "command" },
    { group: "trigger", file: "commands/trigger.ts", switchVar: "sub" },
    { group: "governance", file: "commands/governance.ts" },
  ];

  for (const { group, file, switchVar } of dispatchCases) {
    test(`\`keryx ${group} --help\` names every subcommand ${file} dispatches`, async () => {
      const source = readFileSync(path.join(import.meta.dir, file), "utf8");
      const names = dispatchedNames(source, switchVar);
      expect(names.size).toBeGreaterThan(0);

      const cliPath = path.join(import.meta.dir, "cli.ts");
      const output = await runBun([cliPath, group, "--help"]);
      const missing = [...names].filter((name) => !output.includes(name)).sort();
      expect(missing).toEqual([]);
    });
  }

  test("`keryx agents --help` names every `agents external` subcommand agents-external.ts dispatches", async () => {
    const source = readFileSync(path.join(import.meta.dir, "commands/agents-external.ts"), "utf8");
    const names = dispatchedNames(source);
    expect(names.size).toBeGreaterThan(0);

    // `agents` is already a DEEP_HELP_GROUPS entry (its own handler answers
    // `--help` directly), so this is confirming the existing behaviour stays
    // complete, not routing anything new — `agents external` was already
    // fully listed before this flow.
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const output = await runBun([cliPath, "agents", "--help"]);
    const missing = [...names].filter((name) => !output.includes(name)).sort();
    expect(missing).toEqual([]);
  });

  test("`keryx serve-mcp --help` names every flag serve-mcp.ts's own help declares", async () => {
    const source = readFileSync(path.join(import.meta.dir, "commands/serve-mcp.ts"), "utf8");
    const flags = new Set<string>();
    for (const match of source.matchAll(/flag: "(--[a-z-]+)"/g)) {
      flags.add(match[1] as string);
    }
    expect(flags.size).toBeGreaterThan(0);

    const cliPath = path.join(import.meta.dir, "cli.ts");
    const output = await runBun([cliPath, "serve-mcp", "--help"]);
    const missing = [...flags].filter((flag) => !output.includes(flag)).sort();
    expect(missing).toEqual([]);
  });

  test("a mutating trigger subcommand's --help stays intercepted rather than reaching the handler unguarded", async () => {
    // The regression this routing could have reintroduced: `trigger install`
    // has no `--help` check of its own (unlike `run`/`schedule`), so if
    // `trigger` were answered by letting the handler see `--help` (the
    // DEEP_HELP_GROUPS approach) instead of by calling its help function
    // directly while still intercepting, this would actually install hooks.
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const output = await runBun([cliPath, "trigger", "install", "--help"]);
    expect(output).not.toContain("installed");
    expect(output).toContain("keryx trigger");
  });
});

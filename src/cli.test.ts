import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  CLI_ROUTES,
  exitCodeForError,
  groupUsage,
  groupsWithKnownSubcommands,
  helpRequestedFor,
  knownSubcommandsFor,
  printCommandHelp,
  shouldInterceptHelp,
} from "./cli";
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
  // Flow 323 (W5-b): brand-new `integrations` verb, same shape as flow 303's
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
    // Flow 325 (W1 Lane A): brand-new `stack` verb — one USAGE_BODY line plus
    // one Commands: summary row, same shape as flow 323's `integrations`.
    "  keryx stack detect [--cwd <dir>] [--json] [--no-write]\n",
    "  stack     Deterministic, offline stack detection (keryx stack detect)\n",
    // Flow 322 (W6, T8): the new `keryx hooks` verb — five USAGE_BODY lines
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
    // Flow 327 (Routing A2): `keryx routing profile list|set` — the
    // model-profile catalogue (tier/price/context/priority + sources), and
    // the routing summary row's text widened to mention it. The row's TEXT
    // is the flow-327 wording directly (not a REPLACED_LINES pair) because
    // the row itself never existed in the pre-flow-303 fixture — flow 305
    // added it as a NEW_LINES entry, and this just updates that same entry.
    "  keryx routing profile list [--json]\n",
    "  keryx routing profile set <provider>/<model> --tier|--price-in|--price-out|--context|--priority <value>\n",
    "  routing   Category -> model routing table (list, set, unset, trust) and the model-profile catalogue (profile list, profile set)\n",
    // Flow 346: `keryx external` — the EXTERNAL switch, a brand-new verb, so
    // both a USAGE_BODY block and a Commands: summary row are added (same
    // shape as flow 305's `routing`, above).
    "  keryx external on [--project] | off [--project]\n",
    "                                               Block/allow sending private work (code, diffs, CI logs, prompts) to Jev/TypeSafe and other listed providers/models\n",
    "  keryx external status [--json]              Effective on/off, source, Jev credential availability, and what is blocked right now\n",
    "  keryx external list [--json]                 The effective block list (providers, model patterns) and where it came from\n",
    "  external  Keep private work in-house: block Jev/TypeSafe and other listed providers/models (on, off, status, list)\n",
    // Flow 353 (W5, AC1): the new `keryx doctor` verb — brand-new, so both a
    // USAGE_BODY line and a Commands: summary row, same shape as flow 305's
    // `routing`/flow 346's `external` above.
    "  keryx doctor [--json]                        One page: version, Bun floor, ripgrep, sandbox, providers, MCP, integrations, standard, worktrees, graph/wiki freshness\n",
    "  doctor    One-page health check with a fix hint per line; --json for {checks:[...]}\n",
    // `keryx setup`: the read-only Metaproject preparation guide — a brand-new
    // verb, so a USAGE_BODY line and a Commands: summary row, same shape as
    // flow 353's `doctor` above.
    "  keryx setup [init|refresh|repair]            Print the Metaproject preparation guide (does not run it)\n",
    "  setup     Print the Metaproject preparation guide: init, refresh, or repair\n",
    // Flow 362 (product module P1): `keryx product index|open`, a brand-new
    // verb, so both USAGE_BODY lines and a Commands: summary row.
    "  keryx product index [--json]                  Read every flow and requirements package into a disposable intent index; reports entries with no stated intent\n",
    "  keryx product open [--json]                   Intents closed in code with no recorded look back, each with its outcome criterion\n",
    "  product   The product's intent as a derived index, and the intents closed in code that nobody looked back at\n",
    // Flow 369 (R4d): `keryx approvals`, a brand-new verb, so both a USAGE_BODY
    // block and a Commands: summary row.
    "  keryx approvals list [--all] [--json] | allow <id> | deny <id>\n",
    "                                               Answer, from this machine, a call a remote turn is waiting on (once, that call only)\n",
    "  approvals Pending remote approvals: list them, allow or deny one call, once (the local answer path of the serve entry)\n",
    // Flow 392: `keryx decisions`, a brand-new verb, so a USAGE_BODY block (wrapped
    // over three lines) and a Commands: summary row.
    // Flow 392 (backfill): the usage line now names `import` and `report --line`, so the pinned block grew on purpose.
    "  keryx decisions open|answer|reason|report [--json|--line]|import <file.jsonl> [--dry-run] [--json]\n",
    "                                               Recommendation journal: record a question with options and its\n",
    "                                               recommendation before showing it, the human's choice after;\n",
    "                                               report = match share by mode and stage, deviations (no model);\n",
    "                                               import = earlier decisions from a JSON-lines file, kept apart\n",
    "  decisions Recommendation journal: every agent question with options, what was recommended, what the human chose\n",
    // Flow 395: `keryx remote`, a brand-new verb (the Telegram rendering preview).
    "  keryx remote format-sample [--mode auto|rich|html|plain] [--full] [--json]\n",
    "                                               Print the sample reply in each Telegram rendering mode\n",
    "                                               (tables, lists, rules); no network\n",
    "  remote    Telegram remote control: preview how replies are rendered, with no network\n",
    // Flow 396: `keryx permissions`, a brand-new verb, so a USAGE_BODY block and a Commands: summary row.
    "  keryx permissions list [--json] | remove <number|pattern>\n",
    "                                               The saved shell rules an Always answer left behind; take one back\n",
    "  permissions The saved shell rules (what Always remembered): list them, remove one\n",
    // Flow 403: `keryx intake`, a brand-new verb, so a USAGE_BODY block and a Commands: summary row.
    "  keryx intake status|list|pause|resume|poll|report [--json]\n",
    "                                               GitHub work intake: tickets, reviews, failed CI, PR comments and board\n",
    "                                               movement as Telegram cards; report = decisions, answer times, card -> flow -> PR\n",
    "  intake    GitHub work intake: tickets, reviews, failed CI and PR comments as Telegram cards, with a usefulness report\n",
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
  // one synopsis line and one flag line. Flow 328: `flow check-ac`, the
  // advisory Jev-vs-frozen-criteria check — one USAGE line in `flow --help`.
  const RICH_NEW_LINES: Readonly<Record<string, readonly string[]>> = {
    "serve-mcp": [
      "  keryx serve-mcp --harness <id> [--cwd <project-root>]  # bind a cross-harness memory identity\n",
      "  --harness    Bind this server process's cross-harness memory identity once at launch (or set KERYX_HARNESS; --harness wins). Used by memory.search filtering, memory.handoff, and the Source-Harness stamped on memory.propose writes. Unknown id refuses to start.\n",
    ],
    governance: [
      "\nEach flow also shows its acceptance coverage: how many criteria are runnable\n(exec or invariant) of all of them. A flow frozen before verification kinds\nexisted reads as fully unclassified, not as zero criteria.\n",
      // Flow 364: the summary and stated effect per flow.
      "\nEach flow also shows a summary (its expected outcome, tasks done, tasks still\nopen) and its stated effect (the Outcome criteria in description.md), or says\nthe effect is not stated. In keryx shell, /governance lists the flows and can\ncheck and complete an open one.\n",
    ],
    flow: [
      "  keryx flow ac kinds <id> [--json]   (verification kind per criterion; read-only, never gates)\n",
      "  keryx flow check-ac <id> [--diff <ref>|--pr <n>] [--json] [--refresh]   (ADVISORY: Jev vs. the frozen criteria; never changes flow state)\n",
      // Flow 365: who wrote the outcome criterion — the setter's usage line and the note that
      // also documents `flow init --outcome-author`.
      '  keryx flow outcome author <id> agent|human --reason "<why>"   (who wrote the outcome criterion; journaled, gates nothing)\n',
      "  `flow init --outcome-author agent|human` records who wrote the outcome criterion: `agent` (the default when the flag is absent) or `human`, and `human` only when the flag says so — never inferred from a git identity, an owner or the environment. A flow without the field reads `unknown`. The flag labels a sample and gates nothing.\n",
      // Flow 390: where a flow came from — the setter's usage line and the note that also
      // documents `flow init --origin`.
      '  keryx flow origin set <id> human-request|agent-finding|agent-proposal|unknown --reason "<why>" [--quote "<verbatim>"] [--source "<ref>"]   (where the flow came from; journaled, gates nothing)\n',
      "  `flow init --origin human-request|agent-finding|agent-proposal --quote \"<verbatim>\" --source \"<ref>\"` records where the flow came from. Evidence, not assertion: `human-request` is recorded only with a verbatim `--quote` of the human's first message with the idea AND a `--source` (channel, message id or time); `agent-finding` and `agent-proposal` need a `--source`. Without the evidence, or with an invalid kind, the origin stays `unknown`, the command still succeeds and says why. The Outcome criteria template then holds the request (or the source), the agent's formalization and how to observe it. `flow origin set` changes it later, with a reason. The origin labels a sample and gates nothing.\n",
      // Flow 364: the read-only completion check.
      "  keryx flow check-complete <id> [--merged <commit>] [--confirm-token <token>] [--json]   (every completion gate plus the PR's merge state; writes nothing)\n",
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

// Flow 353 AC3: an unknown top-level command used to print `Unknown
// command: <x>` to stderr and then dump the ~9.5 KB flat usage
// (`docs/requirements/backlog.md` item 4) to stdout. One line, on stderr,
// exit 1, never the usage dump; a close typo gets a "did you mean".
describe("keryx <unknown command> (AC3)", () => {
  test("`keryx docto` suggests `doctor`, one line, exit 1, nothing on stdout", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, "docto"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown command: docto. Did you mean: doctor? Run `keryx --help` for the list.");
  });

  test("a nonsense word gets no suggestion, but still one line and exit 1", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, "zzzqxvvv"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown command: zzzqxvvv. Run `keryx --help` for the list.");
  });
});

// Flow 353 review round 1 (blocker L1): the same one-line treatment, but for
// an unknown SUBCOMMAND of a known group (`keryx health rn`, `keryx wiki
// serach`) — previously only the top-level dispatch and `keryx mcp <sub>`
// had it; every other group with real subcommands still dumped its own full
// usage. `groupsWithKnownSubcommands()` is the exact set `cli.ts`'s central
// dispatch checks — iterating it (rather than a second, hand-written list)
// means a group this file stops tracking cannot silently drop out of
// coverage here too.
describe("keryx <group> <unknown subcommand> (review round 1, L1)", () => {
  test.each([...groupsWithKnownSubcommands()])("`keryx %s zzzqxvvv`: exit 1, one stderr line naming its own --help, empty stdout", async (group: string) => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, group, "zzzqxvvv"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(`Unknown command: zzzqxvvv. Run \`keryx ${group} --help\` for the list.`);
  });

  test("`keryx health rn` suggests `run`", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, "health", "rn"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown command: rn. Did you mean: run? Run `keryx health --help` for the list.");
  });

  // "search" is not actually a real `wiki` subcommand (the real dispatch —
  // status/new/index/collect/check-links/validate/freshness/refresh/verify/
  // migrate-markers/ask/sections/enrich/context/backlinks, `commands/wiki.ts`
  // — has no "search") — so "serach" gets no suggestion. The property this
  // still proves is the one that matters: one stderr line, empty stdout,
  // exit 1, never wiki's own full usage dump.
  test("`keryx wiki serach`: one line, empty stdout, exit 1 (no real `search` subcommand to suggest)", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, "wiki", "serach"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown command: serach. Run `keryx wiki --help` for the list.");
  });

  test("a real subcommand of a checked group is unaffected (`keryx health status`, `keryx wiki ask`)", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const health = await runBunCapture([cliPath, "health", "status"]);
    expect(health.code).toBe(0);
    const wiki = await runBunCapture([cliPath, "wiki", "ask", "--help"]);
    // `ask --help` is a question, not a claim about wiki's data — exit 0 either way is not the property under test here; only that it was NOT rejected as "unknown".
    expect(wiki.stderr).not.toContain("Unknown command");
  });

  // Flow 353 review rounds 2–3 (L3, T3, T4): the guard inspects `args[1]` of a
  // MAPPED group only, so the one real positive case is a group whose first
  // positional is not a subcommand word at all — `integrate`'s comma-joined
  // editor list. Re-adding `integrate` to the map fails both assertions below
  // (round 3 showed that path/pattern cases behind a bare subcommand word pass
  // with or without the guard, so they prove nothing and are not here).
  test("a group whose first positional is a comma-joined list is not in the map and is never refused", async () => {
    expect([...groupsWithKnownSubcommands()]).not.toContain("integrate");
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, "integrate", "cursor,claude", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Unknown command");
  });
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

/**
 * Same spawn as {@link runBun}, but it never rejects on the exit code: it
 * resolves with stdout/stderr/code whatever the code was, so a test can assert
 * exit 1 (flow 353 AC3) or exit 0 as the case under test.
 */
function runBunCapture(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
      resolve({ stdout, stderr, code });
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

test("review scope and tier --help reach the handler; ingest --help stays intercepted", () => {
  expect(shouldInterceptHelp("review", ["scope", "--help"])).toBe(false);
  expect(shouldInterceptHelp("review", ["tier", "--help"])).toBe(false);
  expect(shouldInterceptHelp("review", ["tier", "-h"])).toBe(false);
  expect(shouldInterceptHelp("review", ["ingest", "--help"])).toBe(true);
  expect(shouldInterceptHelp("review", ["--help"])).toBe(true);
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

// Flow 360 (AC11): `--help` on a `review`/`skills` subcommand used to print a
// slice of the static `USAGE_BODY` — `keryx review --help` named 5 of the ~30
// subcommands the router handles, and `keryx skills import --help` printed the
// generic skills list, so the import/update help printers were dead code.
//
// The mechanism under test: `--help` STAYS intercepted (no route ever runs),
// and `printCommandHelp(command, rest)` hands `rest` to the group's own help
// function, which picks the named subcommand's printer from a table the
// command module owns.
describe("flow 360 AC11: --help reaches a review/skills subcommand's own usage, without running it", () => {
  /** Everything `run` prints through `console.log`, joined. */
  async function captureLog(run: () => Promise<void> | void): Promise<string> {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "));
    };
    try {
      await run();
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  /** Every `command === "x"` the `reviewCommand` router compares against — read from SOURCE, not a second list. */
  function reviewRouterSubcommands(): string[] {
    return routerSubcommands("commands/review.ts", "reviewCommand");
  }

  /** The same, for any group router written as a chain of `command === "x"` comparisons. */
  function routerSubcommands(file: string, routerFunction: string): string[] {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    const headerAt = source.indexOf(`export async function ${routerFunction}(`);
    expect(headerAt).toBeGreaterThan(-1);
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
    const names = new Set<string>();
    for (const match of source.slice(bodyStart, i + 1).matchAll(/\bcommand === "([a-z][a-z0-9-]*)"/g)) {
      names.add(match[1] as string);
    }
    return [...names].sort();
  }

  test("`keryx review --help` has a usage line for every subcommand the router handles", async () => {
    const names = reviewRouterSubcommands();
    expect(names.length).toBeGreaterThan(20);

    const cliPath = path.join(import.meta.dir, "cli.ts");
    const output = await runBun([cliPath, "review", "--help"]);
    const missing = names.filter((name) => !new RegExp(`^\\s+keryx review ${name}(?:\\s|$)`, "m").test(output));
    expect(missing).toEqual([]);
  });

  test("`keryx help review` prints the same complete list", async () => {
    const output = await captureLog(() => printCommandHelp("review"));
    const missing = reviewRouterSubcommands().filter((name) => !output.includes(`keryx review ${name}`));
    expect(missing).toEqual([]);
  });

  test("the review router and the known-subcommand table name the same subcommands", () => {
    // The third copy of this list (`lib/group-subcommands.ts`) decides which
    // first tokens are refused as typos BEFORE the router runs — a subcommand
    // added to the router but not there is unreachable, however well documented.
    expect([...(knownSubcommandsFor("review") ?? [])].sort()).toEqual(reviewRouterSubcommands());
  });

  // Flow 360 review F-020: a `skills` subcommand is registered in four places —
  // the router, the known-subcommand table, the group help and (when it has
  // help of its own) `SKILLS_SUBCOMMAND_HELP`. The router is the source; the
  // other three are checked against it, so one cannot be forgotten.
  describe("skills parity", () => {
    const skillsRouterSubcommands = (): string[] => routerSubcommands("commands/skills.ts", "skillsCommand");

    /** The keys of `SKILLS_SUBCOMMAND_HELP`, read from source: the table is module-private. */
    function skillsOwnHelpSubcommands(): string[] {
      const source = readFileSync(path.join(import.meta.dir, "commands/skills.ts"), "utf8");
      const tableAt = source.indexOf("const SKILLS_SUBCOMMAND_HELP");
      expect(tableAt).toBeGreaterThan(-1);
      const table = source.slice(tableAt, source.indexOf("]);", tableAt));
      return [...table.matchAll(/^\s*\["([a-z][a-z0-9-]*)",/gm)].map((match) => match[1] as string).sort();
    }

    test("skills parity: the router and the known-subcommand table name the same subcommands", () => {
      const names = skillsRouterSubcommands();
      expect(names.length).toBeGreaterThan(15);
      expect([...(knownSubcommandsFor("skills") ?? [])].sort()).toEqual(names);
    });

    test("skills parity: `keryx skills --help` has a usage line for every subcommand the router handles", async () => {
      const output = await captureLog(() => printCommandHelp("skills"));
      const missing = skillsRouterSubcommands().filter((name) => !new RegExp(`^\\s+keryx skills ${name}(?:\\s|$)`, "m").test(output));
      expect(missing).toEqual([]);
    });

    test("skills parity: every routed subcommand has help of its own, or is pinned here as answered by the group help", () => {
      const ownHelp = skillsOwnHelpSubcommands();
      const routed = skillsRouterSubcommands();
      // A help-table key the router does not dispatch documents a command that does not exist.
      expect(ownHelp.filter((name) => !routed.includes(name))).toEqual([]);
      // A new subcommand lands in this list unless it is given a printer in
      // `SKILLS_SUBCOMMAND_HELP` — adding it here is then a decision, not an omission.
      expect(routed.filter((name) => !ownHelp.includes(name))).toEqual([
        "catalog",
        "eval",
        "install",
        "judge-check",
        "list",
        "scout",
        "status",
        "stocktake",
      ]);
    });
  });

  const OWN_HELP: ReadonlyArray<{ argv: string[]; has: string[]; lacks: string }> = [
    { argv: ["skills", "import", "--help"], has: ["keryx skills import --from"], lacks: "keryx skills catalog" },
    { argv: ["skills", "update", "-h"], has: ["keryx skills update --all"], lacks: "keryx skills catalog" },
    { argv: ["skills", "remove", "--help"], has: ["keryx skills remove <module>/<name>"], lacks: "keryx skills catalog" },
    { argv: ["review", "import", "--help"], has: ["keryx review import --from"], lacks: "keryx review attach" },
    {
      argv: ["review", "comments", "--help"],
      // The last one is the `comments:` paragraph of the group help, reused.
      has: ["keryx review comments collect", "keryx review comments reply", "collected EVERY round"],
      lacks: "keryx review attach",
    },
    { argv: ["review", "comments", "reply", "--help"], has: ["keryx review comments reply"], lacks: "keryx review attach" },
    {
      argv: ["review", "learn", "--help"],
      has: ["keryx review learn --pr", "keryx review learn --reviewer", "NEVER fetches from GitHub"],
      lacks: "keryx review attach",
    },
  ];

  for (const { argv, has, lacks } of OWN_HELP) {
    test(`\`keryx ${argv.join(" ")}\` prints that subcommand's own usage`, async () => {
      const [command, ...rest] = argv as [string, ...string[]];
      // Intercepted: the route never sees the token, so nothing can execute.
      expect(shouldInterceptHelp(command, rest)).toBe(true);
      const output = await captureLog(() => printCommandHelp(command, rest));
      for (const expected of has) {
        expect(output).toContain(expected);
      }
      // …and it is the subcommand's help, not the whole group's.
      expect(output).not.toContain(lacks);
    });
  }

  test("end to end: `keryx skills import --help` prints the import usage and exits 0", async () => {
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const result = await runBunCapture([cliPath, "skills", "import", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("keryx skills import --from");
    expect(result.stdout).not.toContain("keryx skills catalog");
  });

  test("a subcommand with no help of its own falls back to the group's help instead of running", async () => {
    // `review lightweight` ignores every argument and prints a status line;
    // `skills install` writes files. Neither may run on a question.
    expect(shouldInterceptHelp("review", ["lightweight", "--help"])).toBe(true);
    const cliPath = path.join(import.meta.dir, "cli.ts");
    const lightweight = await runBunCapture([cliPath, "review", "lightweight", "--help"]);
    expect(lightweight.code).toBe(0);
    expect(lightweight.stdout).not.toContain("lightweight review mode:");
    expect(lightweight.stdout).toContain("keryx review attach");

    expect(shouldInterceptHelp("skills", ["install", "--help"])).toBe(true);
    const install = await captureLog(() => printCommandHelp("skills", ["install", "--help"]));
    expect(install).toContain("keryx skills install");
    expect(install).toContain("keryx skills catalog");
  });

  test("only the pinned review subcommands are handed their own `--help`; every other one stays intercepted", () => {
    // `SAFE_SUBCOMMAND_HELP` lets a route see `--help`, which is only safe when
    // that subcommand's handler checks it before doing anything. A subcommand
    // added to that list has to be added here, next to the reason.
    const reachesHandler = reviewRouterSubcommands().filter((name) => !shouldInterceptHelp("review", [name, "--help"]));
    expect(reachesHandler).toEqual(["bot", "metrics", "scope", "tier"]);
  });
});

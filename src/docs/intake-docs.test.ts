// Flow 403, AC22: the docs describe the work intake.
//
// The guide, the CLI reference, the commands-by-task page, the docs nav and index, and the README must all
// know about `keryx intake`. The subcommands and the defaults the docs state are checked against the code,
// so the docs cannot drift from it.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_INTAKE_CONFIG } from "../intake/config";

const REPO = path.resolve(import.meta.dir, "..", "..");
const read = (relative: string): Promise<string> => readFile(path.join(REPO, relative), "utf8");

const GUIDE = "docs/docs/guides/work-intake.md";

/** The `## intake` section of the CLI reference, up to the next `## ` heading. */
async function cliIntakeSection(): Promise<string> {
  const text = await read("docs/docs/cli-reference.md");
  const start = text.indexOf("\n## intake\n");
  expect(start).toBeGreaterThan(0);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next > 0 ? next : undefined);
}

/** The subcommands `keryx intake` routes, read from the source so a new one cannot be left undocumented. */
async function routedSubcommands(): Promise<string[]> {
  const source = await read("src/commands/intake.ts");
  const match = /const SUBCOMMANDS = \[([^\]]+)\] as const;/.exec(source);
  expect(match).not.toBeNull();
  return [...match![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
}

describe("AC22: the guide", () => {
  test("it exists, is titled for the task and says what intake is and who runs it", async () => {
    const guide = await read(GUIDE);
    expect(guide.startsWith("# Take work in from GitHub as cards in Telegram")).toBe(true);
    expect(guide).toContain("**Work intake**");
    expect(guide).toContain("`keryx serve` polls");
    expect(guide).toContain("Intake");
  });

  test("it names every watched source and every button", async () => {
    const guide = await read(GUIDE);
    for (const word of ["Issue", "Review", "CI", "Comment", "Board"]) expect(guide).toContain(`| ${word} |`);
    for (const label of ["Взять в работу", "Отклонить", "Позже", "Открыть ревью-flow", "Пропустить", "Разобрать", "Игнорировать", "Понятно"]) {
      expect(guide).toContain(`**${label}**`);
    }
  });

  test("it explains the baseline, dedupe, quiet hours, the hourly cap and the overflow card", async () => {
    const guide = await read(GUIDE);
    expect(guide).toContain("The first poll is a baseline");
    expect(guide).toContain("deduplicated");
    expect(guide).toContain("Quiet hours");
    expect(guide).toContain("overflow card");
    expect(guide).toContain(`At most ${DEFAULT_INTAKE_CONFIG.cardsPerHour} cards an hour`);
  });

  test("it states the button lifetime, the reminder and the budget the code uses", async () => {
    const guide = await read(GUIDE);
    expect(guide).toContain(`Buttons live ${DEFAULT_INTAKE_CONFIG.buttonTtlHours} hours`);
    expect(guide).toContain(`(${DEFAULT_INTAKE_CONFIG.laterHours} h by default)`);
    expect(guide).toContain("Reminds you once");
    expect(guide).toContain("`budgetUsd`");
  });

  test("every default it states in the settings table is the default of the code", async () => {
    const guide = await read(GUIDE);
    const scalar = ["enabled", "intervalMinutes", "cardsPerHour", "buttonTtlHours", "laterHours", "budgetUsd", "maxSeconds", "memoryLimitMb", "rows", "allowTakeInWork"] as const;
    for (const key of scalar) {
      const row = new RegExp(`\\| \`${key}\` \\| \`?${String(DEFAULT_INTAKE_CONFIG[key])}\`? \\|`);
      expect(row.test(guide)).toBe(true);
    }
    expect(guide).toContain(`| \`repos\` | \`${JSON.stringify(DEFAULT_INTAKE_CONFIG.repos)}\` |`);
    // the topic is not a setting any more: the table has no such row, and the guide says a stored one is ignored
    expect(guide).not.toContain("| `topic` |");
    expect("topic" in DEFAULT_INTAKE_CONFIG).toBe(false);
    expect(guide).toContain("A `topic` key in an old config file is ignored");
    expect(guide).toContain(`"startHour": ${DEFAULT_INTAKE_CONFIG.quietHours.startHour}`);
    expect(guide).toContain(`"endHour": ${DEFAULT_INTAKE_CONFIG.quietHours.endHour}`);
  });

  test("it says how to turn it on, that work repositories cannot take, and how to pause", async () => {
    const guide = await read(GUIDE);
    expect(guide).toContain(".metaproject/data/intake/config.json");
    expect(guide).toContain("off until you opt in");
    expect(guide).toContain("refuses with a one-line");
    expect(DEFAULT_INTAKE_CONFIG.enabled).toBe(false);
    expect(DEFAULT_INTAKE_CONFIG.repos).toEqual([]);
    expect(guide).toContain("Take button is not shown");
    expect(guide).toContain("allowTakeInWork");
    expect(guide).toContain("keryx intake pause");
    expect(guide).toContain("keryx intake resume");
  });

  test("it states the read-only guarantee", async () => {
    const guide = await read(GUIDE);
    expect(guide).toContain("## The read-only guarantee");
    expect(guide).toContain("Intake cannot change anything on GitHub");
    for (const tool of ["gh.issue.assigned", "gh.pr.review-requested", "gh.pr.comments", "gh.run.failed"]) expect(guide).toContain(`\`${tool}\``);
  });

  test("it covers the TUI: the sidebar line and the /intake modal", async () => {
    const guide = await read(GUIDE);
    expect(guide).toContain("## In `keryx shell`");
    expect(guide).toContain("`/intake`");
    expect(guide).toContain("sidebar");
  });

  test("it does not name a person's employer, team or working hours", async () => {
    const guide = await read(GUIDE);
    expect(guide).not.toMatch(/presight|aleksandr-tsaitler/i);
  });
});

describe("AC22: registration", () => {
  test("the docs nav and the docs index link the guide", async () => {
    expect(await read("mkdocs.yml")).toContain("guides/work-intake.md");
    expect(await read("docs/docs/index.md")).toContain("(guides/work-intake.md)");
  });

  test("the README links the guide", async () => {
    expect(await read("README.md")).toContain("docs/docs/guides/work-intake.md");
  });

  test("the changelog has an entry for it", async () => {
    const changelog = await read("CHANGELOG.md");
    const entry = changelog.split("\n").find((line) => line.includes("Work intake from GitHub (flow 403)"));
    expect(entry).toBeDefined();
    expect(entry).toContain("keryx intake");
  });
});

describe("AC22: the CLI reference and the commands-by-task page", () => {
  test("the CLI reference has an intake section that links the guide", async () => {
    const section = await cliIntakeSection();
    expect(section).toContain("(guides/work-intake.md)");
    expect(section).toContain("keryx intake");
  });

  test("every subcommand the CLI routes is named in the intake section", async () => {
    const section = await cliIntakeSection();
    const subs = await routedSubcommands();
    expect(subs.length).toBeGreaterThan(0);
    for (const sub of subs) expect(section).toContain(`keryx intake ${sub}`);
  });

  test("the CLI reference names the --json flag", async () => {
    expect(await cliIntakeSection()).toContain("--json");
  });

  test("commands-by-task lists keryx intake", async () => {
    expect(await read("docs/docs/commands-by-task.md")).toContain("keryx intake");
  });
});

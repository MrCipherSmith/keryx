// `keryx intake` (flow 403): the operator's view of the GitHub work intake.
//
//   status   what is waiting, when the next poll is due, which gh account the project's path selects
//   list     the cards, newest first
//   pause    stop the automatic poll (cards already queued still go out)
//   resume   start it again
//   poll     one poll now, even while paused; new cards are queued and go out with the next serve tick
//   report   what the cards were worth: decisions, answer times, match with the suggestion, card -> flow -> PR
//
// Nothing here writes to GitHub. A poll reads through the granted read-only gh tools.

import { runIntakePoll } from "../intake/poll";
import { buildIntakeReport, formatIntakeReport } from "../intake/report";
import { buildIntakeStatus, setIntakePaused } from "../intake/status";
import { readIntakeCardViews } from "../intake/store";
import type { IntakeCardView, IntakeStatus } from "../intake/types";

const SUBCOMMANDS = ["status", "list", "pause", "resume", "poll", "report"] as const;

function formatStatus(status: IntakeStatus): string {
  const lines = [
    status.line,
    `  включён: ${status.enabled ? "да" : "нет"}${status.paused ? " (пауза)" : ""}${status.quiet ? "; сейчас тихие часы" : ""}`,
    `  ждут решения: ${status.waiting}; в очереди на отправку: ${status.queued}; отложено: ${status.deferred}; решено: ${status.decided}`,
    `  репозитории: ${status.repos.join(", ") || "не заданы"}; аккаунт GitHub по пути проекта: ${status.ghAccount}`,
    `  последний опрос: ${status.lastPollAt ?? "ещё не было"}`,
  ];
  if (status.lastRun !== undefined) lines.push(`  итог последнего: ${status.lastRun.outcome} — ${status.lastRun.detail}`);
  return `${lines.join("\n")}\n`;
}

function formatCards(cards: readonly IntakeCardView[]): string {
  if (cards.length === 0) return "Карточек пока нет.\n";
  const rows = cards.map((c) => `${c.id}  ${c.state.padEnd(11)} ${c.kind.padEnd(8)} ${c.repo ?? ""}${c.repo !== undefined ? " " : ""}${c.title}${c.choice !== undefined ? `  → ${c.choice}` : ""}`);
  return `${rows.join("\n")}\n`;
}

function usage(): string {
  return `keryx intake — work from GitHub as cards in Telegram

Usage:
  keryx intake status [--json]
  keryx intake list [--json]
  keryx intake pause
  keryx intake resume
  keryx intake poll [--json]
  keryx intake report [--json]

The poll reads tickets assigned to you, review requests, failed CI and comments on your PRs, and board movement.
The first poll only takes a baseline. Nothing is written to GitHub.
`;
}

export function printIntakeHelp(): void {
  process.stdout.write(usage());
}

export async function intakeCommand(args: string[] = []): Promise<void> {
  const sub = args[0];
  const asJson = args.includes("--json");
  if (sub === undefined || sub === "--help" || sub === "-h") {
    printIntakeHelp();
    return;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    console.error(`Unknown intake subcommand: ${sub}`);
    printIntakeHelp();
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();

  if (sub === "status") {
    const status = await buildIntakeStatus(root);
    process.stdout.write(asJson ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    return;
  }
  if (sub === "list") {
    const cards = (await readIntakeCardViews(root)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    process.stdout.write(asJson ? `${JSON.stringify(cards, null, 2)}\n` : formatCards(cards));
    return;
  }
  if (sub === "pause" || sub === "resume") {
    await setIntakePaused(root, sub === "pause");
    process.stdout.write(sub === "pause" ? "Intake: автоматический опрос на паузе.\n" : "Intake: опрос возобновлён.\n");
    return;
  }
  if (sub === "poll") {
    const result = await runIntakePoll(root, { manual: true });
    if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Intake: ${result.outcome} — ${result.detail}\n`);
      for (const f of result.failures) process.stdout.write(`  ${f.source}: ${f.detail}\n`);
      if (result.reportPath !== undefined) process.stdout.write(`  отчёт: ${result.reportPath}\n`);
    }
    if (result.outcome === "failed") process.exitCode = 1;
    return;
  }
  const report = await buildIntakeReport(root);
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : formatIntakeReport(report));
}

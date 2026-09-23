// `keryx help [group|command]` (flow 303, AC3/AC4/AC10).
//
// A separate verb from `--help`/`-h`/bare `keryx` (AC5, which keep printing
// the flat `USAGE_BODY` unchanged): with no argument this prints every
// onboarding group, in order, with every CLI verb's one-line summary
// (AC3); with a group slug it prints just that group (AC4); with a known
// verb name it prints that verb's full usage — the existing rich group help
// where one exists (AC4, AC5); with a slash-command name it prints that
// command's detail (it has no standalone CLI usage, so the detail names
// where to type it); an unknown name exits non-zero and names the closest
// matches (AC4).
//
// This file is an ADAPTER (`src/commands/**`) and reaches the HELP_GROUPS
// table only through the core facade `../standard/service` — see the zone
// note at the top of `src/standard/help-groups.ts`.
import { CLI_ROUTES, printCommandHelp } from "../cli";
import {
  closestHelpTopics,
  findSlashEntry,
  groupBySlug,
  renderCliGroupHelp,
  renderEntryDetail,
  renderGroupedCliHelp,
} from "../standard/service";

export async function helpCommand(rest: string[]): Promise<void> {
  const arg = rest[0];

  if (arg === undefined) {
    console.log(renderGroupedCliHelp());
    return;
  }

  const group = groupBySlug(arg);
  if (group !== undefined) {
    console.log(renderCliGroupHelp(group));
    return;
  }

  if (arg in CLI_ROUTES) {
    await printCommandHelp(arg);
    return;
  }

  const slash = findSlashEntry(arg);
  if (slash !== undefined) {
    console.log(renderEntryDetail(slash));
    return;
  }

  console.error(`Unknown help topic: ${arg}`);
  const suggestions = closestHelpTopics(arg);
  if (suggestions.length > 0) {
    console.error(`Did you mean: ${suggestions.join(", ")}?`);
  }
  console.error("Run `keryx help` for the full grouped list.");
  process.exitCode = 1;
}

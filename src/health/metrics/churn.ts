import { runCommand, commandExists, isSourceFile } from "../util";

// Returns churn (added + deleted lines) per relative file path over the window.
export async function getChurn(
  cwd: string,
  windowDays: number,
): Promise<Map<string, number>> {
  const churn = new Map<string, number>();
  if (!commandExists("git")) {
    return churn;
  }

  const result = await runCommand(
    [
      "git",
      "log",
      `--since=${windowDays} days ago`,
      "--numstat",
      "--format=",
      "--no-renames",
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    return churn;
  }

  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) {
      continue;
    }
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const deleted = match[2] === "-" ? 0 : Number(match[2]);
    const file = match[3] ?? "";
    if (!isSourceFile(file)) {
      continue;
    }
    churn.set(file, (churn.get(file) ?? 0) + added + deleted);
  }

  return churn;
}

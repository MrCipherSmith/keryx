import { hiddenInCard } from "../lib/card-safe";
import { isAutonomousEnv, readRunProfile } from "../review/run-profile";
import { formatCompletionException, type CompletionExceptionSelection } from "../flow/service";
import { completionHostAnswer } from "./review-operator";

export class CompletionConfirmationError extends Error {}

export function acceptedGateArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--accept-gate" && !arg.startsWith("--accept-gate=")) continue;
    const value = arg === "--accept-gate" ? args[++i] : arg.slice(14);
    if (!value || value.startsWith("--") || value.split(",").some((s) => !s.trim())) {
      throw new CompletionConfirmationError("--accept-gate needs a gate or review:condition");
    }
    result.push(...value.split(",").map((s) => s.trim()));
  }
  return result;
}

async function ttyAnswer(prompt: string): Promise<string> {
  const { openSync, closeSync, readSync, writeSync } = await import("node:fs");
  const fd = openSync("/dev/tty", "r+");
  try {
    writeSync(fd, prompt);
    const buffer = Buffer.alloc(256);
    let line = "";
    while (!line.includes("\n") && line.length <= 4096) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      line += buffer.subarray(0, n).toString("utf8");
    }
    return line.split(/\r?\n/)[0] ?? "";
  } finally { closeSync(fd); }
}

export async function confirmCompletionExceptions(
  args: string[], selected: readonly CompletionExceptionSelection[], id: string, cwd: string,
  seams: { env?: Readonly<Record<string, string | undefined>>; isTerminal?: boolean; readAnswer?: (question: string) => Promise<string> } = {},
) {
  const env = seams.env ?? process.env;
  if (args.some((arg) => arg === "--answered-by" || arg.startsWith("--answered-by="))) {
    return completionHostAnswer(args, selected, id, cwd, env);
  }
  if (env["KERYX_TOOL_CALL"] === "1" || env["KERYX_UNATTENDED"] === "1" || isAutonomousEnv(env) || readRunProfile(cwd)?.mode === "unattended" ||
      !(seams.isTerminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))) {
    throw new CompletionConfirmationError("Exception completion needs the operator's terminal, host question or flow_complete_exceptions card.");
  }
  const lines = selected.map(formatCompletionException);
  if (lines.some(hiddenInCard)) throw new CompletionConfirmationError("Exception text contains hidden characters; nothing recorded.");
  const answer = await (seams.readAnswer ?? ttyAnswer)(`Complete flow ${id} with exceptions?\n${lines.join("\n")}\nType yes/да to accept: `);
  if (!/^(yes|y|да)$/iu.test(answer.trim())) return undefined;
  return { operatorWords: answer, confirmedVia: "terminal" as const };
}

// Flow 456 (AC5): every review TTY gate says what to do instead. Inside keryx shell the agent calls the card tool and the
// operator answers it; outside keryx shell the operator runs the command in a terminal. Behaviour in a real terminal is
// unchanged and covered by the gate tests next to each command.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runChunks } from "./review-chunks";
import { reviewCommand } from "./review";

const noTerminal = { isTerminal: () => false };

async function refusal(args: string[]): Promise<string> {
  const errors: string[] = [];
  const logError = console.error;
  console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
  try {
    process.exitCode = 0;
    await reviewCommand(args, noTerminal);
    expect(process.exitCode).toBe(1);
  } finally {
    console.error = logError;
  }
  return errors.join("\n");
}

afterEach(() => {
  process.exitCode = 0;
});

describe("review TTY refusals name the card tool", () => {
  test("chunks estimate --answer names review_chunks_answer", async () => {
    const message = await runChunks(["estimate", "--package", "nowhere", "--answer", "yes", "--quote", "go ahead"], { rejectUnknownFlags: () => undefined }, noTerminal).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toContain("--answer needs a terminal");
    expect(message).toContain("review_chunks_answer");
    expect(message).toContain("Outside keryx shell, run this command in a terminal");
  });

  test("complete --waive-coverage names review_waive_coverage", async () => {
    const message = await refusal(["complete", "no-such-review", "--waive-coverage", "the operator accepts the gap"]);
    expect(message).toContain("--waive-coverage needs a terminal");
    expect(message).toContain("review_waive_coverage");
    expect(message).toContain("Outside keryx shell, run this command in a terminal");
  });

  test("complete --waive names review_waive_readiness", async () => {
    const message = await refusal(["complete", "no-such-review", "--waive", "verifier", "the operator said ship it"]);
    expect(message).toContain("--waive needs a terminal");
    expect(message).toContain("review_waive_readiness");
    expect(message).toContain("Outside keryx shell, run this command in a terminal");
  });

  test("publish's no-terminal text names review_publish (behaviour covered in review/publish.test.ts)", () => {
    const source = readFileSync(new URL("./review.ts", import.meta.url), "utf8");
    expect(source).toContain("Not posted: the operator has not read the body. Inside keryx shell, call the review_publish tool");
  });
});

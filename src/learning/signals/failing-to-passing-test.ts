// W3 spec, "Deterministic extraction signals" > "Failing→passing test pair".
// Pure over the observation window: no file reads, no network.
import { clampLearningText } from "./text";
import type { ObservationLine, SignalDraft, SignalRunner } from "./types";

const TEST_COMMAND_PATTERN =
  /\b(bun\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|npx\s+(?:jest|vitest)|jest|vitest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|rspec|phpunit|mix\s+test)\b/i;

// A `0 fail...` line is a pass reported in the vocabulary of a failure word —
// checked first so it never trips `FAILURE_PATTERN` below.
const ZERO_FAILURES_PATTERN = /\b0\s*fail(?:ed|ures?)?\b/i;
const FAILURE_PATTERN = /\b[1-9]\d*\s*fail(?:ed|ures?)?\b|\bFAIL\b|\bfailed\b|error:/i;

/** Strips leading `VAR=x` env assignments and a leading `cd <dir> &&`, then collapses whitespace — the normalized test name. */
export function normalizeTestCommand(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^(?:cd\s+\S+\s*&&\s*)+/i, "");
  value = value.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  return value.replace(/\s+/g, " ").trim();
}

function isTestCommand(preview: string): boolean {
  return TEST_COMMAND_PATTERN.test(normalizeTestCommand(preview));
}

function isFailureOutcome(outputPreview: string | null): boolean {
  if (outputPreview === null) return false;
  if (ZERO_FAILURES_PATTERN.test(outputPreview) && !/\bFAIL\b/.test(outputPreview)) return false;
  return FAILURE_PATTERN.test(outputPreview);
}

/**
 * A shell tool-complete/tool-failed event whose `inputPreview` is a test
 * command, paired: the first report for a given normalized test name that
 * fails, followed later (same session or any later observation in the
 * window) by one that passes, yields one draft. Evidence points at the pass
 * line, `weight: 1.5` (a hard binary observation — the strongest deterministic
 * signal, per the confidence-model doc).
 */
export async function failingToPassingTestSignal(_root: string, window: ObservationLine[]): Promise<SignalDraft[]> {
  const drafts: SignalDraft[] = [];
  const pendingFail = new Set<string>();
  for (const line of window) {
    const { event } = line;
    if (event.event !== "tool-complete" && event.event !== "tool-failed") continue;
    if (!isTestCommand(event.inputPreview)) continue;
    const testName = normalizeTestCommand(event.inputPreview);
    const failed = event.event === "tool-failed" || isFailureOutcome(event.outputPreview);
    if (failed) {
      pendingFail.add(testName);
      continue;
    }
    if (!pendingFail.has(testName)) continue;
    pendingFail.delete(testName);
    drafts.push({
      domain: "testing",
      trigger: clampLearningText(`When the test command "${testName}" fails in this project`),
      action: clampLearningText(
        `Treat its failure as a real signal: fix the cause and re-run "${testName}" until it passes before moving on.`,
      ),
      evidence: [
        {
          kind: "reinforcement",
          sourceType: "test",
          sourceRef: line.sourceRef,
          observedAt: event.observedAt,
          weight: 1.5,
        },
      ],
      extractor: "failing-to-passing-test",
    });
  }
  return drafts;
}

export const FAILING_TO_PASSING_TEST_SIGNAL: SignalRunner = {
  name: "failing-to-passing-test",
  domain: "testing",
  run: failingToPassingTestSignal,
};

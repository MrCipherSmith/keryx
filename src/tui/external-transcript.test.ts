// Flow 176 T16 — the pure external transcript / Meta / Command views.
// Package: docs/requirements/keryx-external-agent-runtime §8.2, D-11.
import { describe, expect, test } from "bun:test";
import type { ExternalEvent } from "../harness/external/types";
import {
  EXTERNAL_COST_MISSING,
  EXTERNAL_TRANSCRIPT_EMPTY,
  describeToolCall,
  foldExternalTranscript,
  formatCostUnits,
  formatExternalCommand,
  formatExternalMeta,
  formatExternalWork,
  renderExternalTranscript,
  shellQuote,
  type ExternalRunView,
} from "./external-transcript";

const view = (over: Partial<ExternalRunView> = {}): ExternalRunView => ({
  id: "ext:1",
  agentId: "codex-cli",
  events: [],
  ...over,
});

describe("renderExternalTranscript", () => {
  test("reads like a terminal: `● $ command` then an indented result", () => {
    const events: ExternalEvent[] = [
      { kind: "child_started", sessionRef: "thread-1" },
      { kind: "tool_call", name: "command_execution", detail: "bun test" },
      { kind: "tool_result", detail: "42 pass, 0 fail" },
      { kind: "assistant_text", text: "The suite is green." },
      { kind: "child_finished", text: "done" },
    ];
    const lines = renderExternalTranscript(events, { summary: false });
    expect(lines).toEqual([
      "● started · session thread-1",
      "● $ bun test",
      "  └ 42 pass, 0 fail",
      "The suite is green.",
      "● finished",
      "  done",
    ]);
  });

  test("a claude tool call shows its TARGET, not the raw JSON input blob", () => {
    const lines = renderExternalTranscript(
      [{ kind: "tool_call", name: "Read", detail: '{"file_path":"src/tui/main-queue.ts","limit":40}' }],
      { summary: false },
    );
    expect(lines).toEqual(["● Read: src/tui/main-queue.ts"]);
  });

  test("a claude Bash call renders as a shell line", () => {
    expect(describeToolCall("Bash", '{"command":"git status","description":"check"}')).toBe("$ git status");
    expect(describeToolCall("command_execution", undefined)).toBe("$ (command not reported)");
  });

  test("unparseable tool detail degrades to the raw first line rather than dropping the call", () => {
    expect(describeToolCall("Grep", "{not json")).toBe("Grep: {not json");
    expect(describeToolCall("Grep", "line one\nline two")).toBe("Grep: line one …");
  });

  test("thinking, operator messages and retries each get their own glyph", () => {
    const lines = renderExternalTranscript(
      [
        { kind: "thinking", text: "considering\noptions" },
        { kind: "user_message", text: "stop and check the tests" },
        { kind: "retry", message: "api retry 1/5, status 429" },
      ],
      { summary: false },
    );
    expect(lines).toEqual([
      "✻ considering",
      "  options",
      "› stop and check the tests",
      "⟳ api retry 1/5, status 429",
    ]);
  });

  test("a long tool result is capped with a +N lines note, never dropped silently", () => {
    const detail = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const lines = renderExternalTranscript([{ kind: "tool_result", detail }], {
      summary: false,
      maxResultLines: 3,
    });
    expect(lines).toEqual(["  └ a", "    b", "    c", "    … +5 more lines"]);
  });

  test("a failed run renders its terminal cause", () => {
    const lines = renderExternalTranscript([{ kind: "child_failed", message: "not logged in" }], {
      summary: false,
    });
    expect(lines).toEqual(["✗ not logged in"]);
  });

  test("no events yet is stated, not blank", () => {
    expect(renderExternalTranscript([])).toEqual([EXTERNAL_TRANSCRIPT_EMPTY]);
  });

  test("the footer carries retries, derived turns, tool calls and cost", () => {
    const events: ExternalEvent[] = [
      { kind: "tool_call", name: "Read", detail: '{"file_path":"a.ts"}' },
      { kind: "assistant_text", text: "one" },
      { kind: "assistant_text", text: "two" },
      { kind: "retry", message: "reconnecting 1/5" },
      { kind: "usage", inputTokens: 10, outputTokens: 5, costUnits: 0.25 },
      { kind: "child_finished" },
    ];
    const lines = renderExternalTranscript(events);
    expect(lines.at(-1)).toBe("── finished · 1 tool call · 2 turns (derived) · 1 retry · cost 0.2500");
  });

  test("a run with no reported cost shows MISSING in the footer, never 0", () => {
    const lines = renderExternalTranscript([{ kind: "usage", inputTokens: 4, outputTokens: 2 }]);
    expect(lines.at(-1)).toContain(`cost ${EXTERNAL_COST_MISSING}`);
    expect(lines.at(-1)).toContain("running");
  });

  test("width clips every line", () => {
    const lines = renderExternalTranscript([{ kind: "assistant_text", text: "0123456789" }], {
      summary: false,
      width: 6,
    });
    expect(lines).toEqual(["01234…"]);
  });
});

describe("foldExternalTranscript", () => {
  test("a later token-only usage event never erases a reported cost", () => {
    const summary = foldExternalTranscript([
      { kind: "usage", costUnits: 1.5 },
      { kind: "usage", inputTokens: 9 },
    ]);
    expect(summary.costUnits).toBe(1.5);
    expect(summary.inputTokens).toBe(9);
  });

  test("counts operator messages and captures the session handle", () => {
    const summary = foldExternalTranscript([
      { kind: "child_started", sessionRef: "s-1" },
      { kind: "user_message", text: "hi" },
    ]);
    expect(summary.sessionRef).toBe("s-1");
    expect(summary.operatorMessages).toBe(1);
    expect(summary.outcome).toBeUndefined();
  });
});

describe("formatCostUnits", () => {
  test("a reported zero prints as zero; an absent figure prints MISSING", () => {
    expect(formatCostUnits(0)).toBe("0.0000");
    expect(formatCostUnits(undefined)).toBe(EXTERNAL_COST_MISSING);
    expect(formatCostUnits(Number.NaN)).toBe(EXTERNAL_COST_MISSING);
  });
});

describe("formatExternalMeta", () => {
  test("carries agent, model, sandbox, session, cost, turns, worktree, skips and warnings", () => {
    const text = formatExternalMeta(
      view({
        agentLabel: "Claude",
        agentId: "claude-cli",
        model: "sonnet",
        sandbox: "read-only",
        worktreePath: "/tmp/wt/ext-1",
        sessionRef: "sess-9",
        costUnits: 0.125,
        skippedLines: 3,
        warnings: ["version 9.9.9 is outside the recorded range", "working diff truncated"],
        status: "Completed",
        events: [{ kind: "assistant_text", text: "hello" }],
      }),
    );
    expect(text).toContain("Claude (claude-cli)");
    expect(text).toContain("sonnet");
    expect(text).toContain("read-only");
    expect(text).toContain("sess-9");
    expect(text).toContain("0.1250");
    expect(text).toContain("1 (derived from transcript");
    expect(text).toContain("/tmp/wt/ext-1");
    expect(text).toContain("3 (possible CLI version drift)");
    expect(text).toContain("outside the recorded range");
    // Both warnings survive; the second hangs under the first.
    expect(text).toContain("working diff truncated");
  });

  test("codex, which reports no cost at all, shows an explained MISSING", () => {
    const text = formatExternalMeta(view({ reportsCost: false }));
    expect(text).toContain(`${EXTERNAL_COST_MISSING} (this CLI reports no cost)`);
    expect(text).not.toContain("0.0000");
  });

  test("a run with no announced handle says it cannot be resumed", () => {
    expect(formatExternalMeta(view())).toContain("cannot be resumed");
  });

  test("an uncounted parse-skip is distinct from zero skips", () => {
    expect(formatExternalMeta(view())).toContain("(not counted)");
    expect(formatExternalMeta(view({ skippedLines: 0 }))).toContain("Parse skips  0");
  });
});

describe("formatExternalCommand", () => {
  test("shows the exact argv, a copy-pasteable shell form and the detach block", () => {
    const text = formatExternalCommand(
      view({
        argv: ["codex", "exec", "--json", "do the thing\nwith a newline"],
        worktreePath: "/tmp/wt/ext-1",
        sessionRef: "thread-7",
        resumeArgv: ["codex", "exec", "resume", "thread-7", "check the tests"],
      }),
    );
    expect(text).toContain("codex");
    expect(text).toContain("Shell form");
    expect(text).toContain("cd /tmp/wt/ext-1");
    expect(text).toContain("codex exec resume thread-7 'check the tests'");
  });

  test("no session handle means the detach block says the run cannot be continued", () => {
    const text = formatExternalCommand(view({ argv: ["codex", "exec"] }));
    expect(text).toContain("cannot be continued by hand");
  });

  test("a refused run states that no argv was ever built", () => {
    expect(formatExternalCommand(view())).toContain("not recorded");
  });

  test("shellQuote protects newlines, quotes and $ so the run is reproducible verbatim", () => {
    expect(shellQuote(["claude", "-p", "cost is $5 'now'"])).toBe("claude -p 'cost is $5 '\\''now'\\'''");
    expect(shellQuote(["a/b_c-1.ts"])).toBe("a/b_c-1.ts");
  });
});

describe("formatExternalWork", () => {
  test("is the transcript joined by newlines", () => {
    const events: ExternalEvent[] = [{ kind: "assistant_text", text: "hi" }];
    expect(formatExternalWork(events, { summary: false })).toBe("hi");
  });
});

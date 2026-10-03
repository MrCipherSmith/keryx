// Flow 400 (AC8): the round-limit picker and the TUI work decisions are journaled with a `source`;
// pure permissions (allow/deny) are not.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offerRoundLimitReset, type AgentDeps } from "../commands/agent";
import { journaledAskUser, journaledPick, setAskUserHost, setAskUserNotice, type PickOption } from "../tui/ask-user-bridge";
import { journalAsk, type AskRequest } from "./ask";
import { openDecision } from "./journal";
import { DECISION_SOURCES, WORK_DECISION_SOURCES } from "./sources";
import { readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-coverage-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  setAskUserHost(undefined);
  setAskUserNotice(undefined);
  await rm(root, { recursive: true, force: true });
});

async function opens(): Promise<OpenRecord[]> {
  return (await readRecords(root)).filter((r): r is OpenRecord => r.kind === "open");
}

const OPTIONS: PickOption[] = [
  { id: "main", label: "Main queue", description: "queue it", recommended: true },
  { id: "side", label: "Side", description: "read-only answer" },
];

describe("the journal records where a decision came from", () => {
  test("openDecision stores `source` on the open record", async () => {
    await openDecision({
      cwd: root,
      question: "Which one?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      source: DECISION_SOURCES.roundLimit,
    });
    expect((await opens())[0]?.source).toBe("round-limit");
  });

  test("a model ask_user is journaled as `ask_user`; a request's own source wins", async () => {
    const ask = async (r: AskRequest): Promise<string> => (r.question === "First?" || r.question === "Second?" ? "a" : "skip");
    const options = [
      { id: "a", label: "A", description: "a", recommended: true },
      { id: "b", label: "B", description: "b" },
    ];
    const journaled = journalAsk(ask, { cwd: root });
    await journaled({ question: "First?", options });
    await journaled({ question: "Second?", options, source: DECISION_SOURCES.wikiEnrich });
    expect((await opens()).map((r) => r.source)).toEqual(["ask_user", "tui-wiki-enrich"]);
  });
});

describe("the round-limit picker", () => {
  test("offerRoundLimitReset journals the question with source round-limit and applies the answer", async () => {
    setAskUserHost(async (request) => (request.source === "round-limit" ? "reset" : "skip"));
    const roundState = { round: 8, maxRounds: 8 };
    const result = await offerRoundLimitReset({ askUser: journaledAskUser(root) } as unknown as AgentDeps, roundState, () => undefined);
    expect(result).toBe("reset");
    expect(roundState.maxRounds).toBeGreaterThan(8);
    const [open] = await opens();
    expect(open?.source).toBe("round-limit");
    expect(open?.recommendation?.optionId).toBe("reset");
    expect((await readRecords(root)).some((r) => r.kind === "answer" && r.choice === "reset")).toBe(true);
  });
});

describe("a TUI work picker", () => {
  test("journaledPick records the source, shows the options the journal hands back, and returns the choice", async () => {
    const shown: PickOption[][] = [];
    const chosen = await journaledPick(
      root,
      { source: DECISION_SOURCES.queueRoute, question: "Where should this go?", options: OPTIONS, recommendationReason: "keeps history", cancelId: "side" },
      async (options) => {
        shown.push(options);
        return "main";
      },
    );
    expect(chosen).toBe("main");
    const [open] = await opens();
    expect(open?.source).toBe("tui-queue-route");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.map((o) => o.id).sort()).toEqual(["main", "side"]);
    // the journal decided the preselection: only arm A with a recommendation starts highlighted
    expect(shown[0]?.some((o) => o.preselected === true)).toBe(open?.arm === "A");
  });

  test("a deviation does not ask a second question (a menu takes no free text); Esc returns the cancel id", async () => {
    let calls = 0;
    const deviated = await journaledPick(root, { source: DECISION_SOURCES.queueRoute, question: "Where?", options: OPTIONS, cancelId: "side" }, async () => {
      calls += 1;
      return "side";
    });
    expect(deviated).toBe("side");
    expect(calls).toBe(1);

    const cancelled = await journaledPick(root, { source: DECISION_SOURCES.wikiEnrich, question: "Which batch?", options: OPTIONS, cancelId: "esc" }, async () => "esc");
    expect(cancelled).toBe("esc");
    expect((await opens()).map((r) => r.source)).toEqual(["tui-queue-route", "tui-wiki-enrich"]);
  });
});

describe("wiring: which pickers are journaled and which are not", () => {
  const read = (file: string): Promise<string> => readFile(path.join(import.meta.dir, "..", file), "utf8");

  test("tui-shell journals exactly the work pickers (wiki enrich, queue routing, held session)", async () => {
    const shell = await read("tui/tui-shell.ts");
    const used = new Set([...shell.matchAll(/source: DECISION_SOURCES\.(\w+)/g)].map((m) => m[1]));
    expect(used).toEqual(new Set(["wikiEnrich", "queueRoute", "sessionLease"]));
    for (const name of used) expect(Object.keys(DECISION_SOURCES)).toContain(name as string);
  });

  test("the allow/deny pickers (shell command, patch, subagent, external agent, mode) stay out of the journal", async () => {
    const shell = await read("tui/tui-shell.ts");
    for (const title of ["Allow shell command?", "Approve apply_patch?", "Spawn general subagent?", "Run the external agent", "Permission mode (current:"]) {
      const at = shell.indexOf(title);
      expect(at).toBeGreaterThan(0);
      // the picker's own call is a bare showComposerChoice, never wrapped in journaledPick
      const before = shell.slice(Math.max(0, at - 700), at);
      expect(before.lastIndexOf("showComposerChoice(")).toBeGreaterThan(before.lastIndexOf("journaledPick("));
    }
  });

  test("the shell hands the agent the journaled ask_user, so the round-limit picker is journaled", async () => {
    const shell = await read("commands/shell.ts");
    expect(shell).not.toContain("askUser: invokeAskUserHost");
    expect(shell.match(/askUser: journaledAskUser\(/g)).toHaveLength(2);
    const agent = await read("commands/agent.ts");
    expect(agent).toContain('source: "round-limit"');
  });

  test("every source is a distinct, non-empty tag", () => {
    expect(new Set(WORK_DECISION_SOURCES).size).toBe(WORK_DECISION_SOURCES.length);
    for (const source of WORK_DECISION_SOURCES) expect(source.length).toBeGreaterThan(0);
  });
});

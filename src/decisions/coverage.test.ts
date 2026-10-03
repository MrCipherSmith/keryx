// Flow 400 (AC8): the round-limit picker and the TUI work decisions are journaled with a `source`;
// pure permissions (allow/deny) are not.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import ts from "typescript";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offerRoundLimitReset, type AgentDeps } from "../commands/agent";
import { journaledAskUser, journaledPick, setAskUserHost, setAskUserNotice, type PickOption } from "../tui/ask-user-bridge";
import { journalAsk, type AskRequest } from "./ask";
import { assignArm, seedFile } from "./arms";
import { openDecision } from "./journal";
import { DECISION_SOURCES, WORK_DECISION_SOURCES } from "./sources";
import { readRecords } from "./store";
import type { OpenRecord } from "./types";

let root: string;

/** A repo salt for which the first question of an empty journal is arm A (default weights): the arm is then a fact, not a draw. */
function saltForFirstArmA(): string {
  for (let i = 0; i < 10_000; i += 1) {
    const salt = `coverage-pinned-salt-${i}`;
    if (assignArm(salt, 1).arm === "A") return salt;
  }
  throw new Error("no salt gives arm A at seq 1");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-coverage-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await mkdir(path.dirname(seedFile(root)), { recursive: true });
  await writeFile(seedFile(root), `${saltForFirstArmA()}\n`, { encoding: "utf8", mode: 0o600 });
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
    expect(open?.arm).toBe("A");
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
    // the pinned salt puts this first question in arm A: only the recommended option starts highlighted
    expect(open?.arm).toBe("A");
    expect(shown[0]?.filter((o) => o.preselected === true).map((o) => o.id)).toEqual(["main"]);
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

  test("a dismissed pick (Esc, busy dock) is journaled as cancelled, never as a choice, even when the cancel id is an option id", async () => {
    // composer-choice resolves the dismissId it was given; the pick hands it a value that is no option id
    const dismissed = await journaledPick(
      root,
      { source: DECISION_SOURCES.queueRoute, question: "Where?", options: OPTIONS, cancelId: "side" },
      async (options, dismissId) => {
        expect(typeof dismissId).toBe("string");
        expect(options.map((o) => o.id)).not.toContain(dismissId);
        return dismissId;
      },
    );
    expect(dismissed).toBe("side");
    expect((await opens()).map((r) => r.source)).toEqual(["tui-queue-route"]);
    expect((await readRecords(root)).filter((r) => r.kind === "answer")).toHaveLength(0);

    // a real pick of that same option id is an answer
    const picked = await journaledPick(
      root,
      { source: DECISION_SOURCES.queueRoute, question: "Where again?", options: OPTIONS, cancelId: "side" },
      async () => "side",
    );
    expect(picked).toBe("side");
    const answers = (await readRecords(root)).filter((r) => r.kind === "answer");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.kind === "answer" ? answers[0].choice : undefined).toBe("side");
  });

  test("every journaledPick caller in tui-shell passes the dismiss id to its dialog as the cancel id", async () => {
    const shell = await readFile(path.join(import.meta.dir, "..", "tui/tui-shell.ts"), "utf8");
    const calls = shell.split("journaledPick(").length - 1;
    expect(calls).toBe(3);
    expect(shell.match(/\(options, dismissId\) =>/g)).toHaveLength(3);
    expect(shell.match(/cancelId: dismissId/g)).toHaveLength(3);
  });
});

const PERMISSION_IDS = new Set(["deny", "allow", "once", "always-exact", "always-prefix"]);

interface PickerAudit {
  /** One entry per `journaledPick(` call; `source` is the DECISION_SOURCES member it names, or undefined when it names anything else. */
  journaled: Array<{ source: string | undefined }>;
  /** `showComposerChoice(` calls that carry an allow/deny id or are the permission-mode picker. */
  permissionPickers: number;
  /** The titles (first 60 chars of the call text) of permission pickers that sit inside a `journaledPick(` call. */
  wrappedPermissionPickers: string[];
  /** Permission ids found as string literals anywhere inside a `journaledPick(` call. */
  permissionIdsInsideJournaled: string[];
}

/** Parse the source and look at every journaledPick / showComposerChoice call, not at the text around them. */
function auditPickers(source: string): PickerAudit {
  const file = ts.createSourceFile("tui-shell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const audit: PickerAudit = { journaled: [], permissionPickers: 0, wrappedPermissionPickers: [], permissionIdsInsideJournaled: [] };
  const calleeName = (node: ts.CallExpression): string | undefined => (ts.isIdentifier(node.expression) ? node.expression.text : undefined);
  const literals = (node: ts.Node): string[] => {
    const found: string[] = [];
    const walk = (child: ts.Node): void => {
      if (ts.isStringLiteralLike(child)) found.push(child.text);
      if (ts.isIdentifier(child) && child.text === "permissionMode") found.push("permissionMode");
      if (ts.isIdentifier(child) && child.text === "PERMISSION_MODES") found.push("permissionMode");
      ts.forEachChild(child, walk);
    };
    walk(node);
    return found;
  };
  const sourceOf = (call: ts.CallExpression): string | undefined => {
    const spec = call.arguments[1];
    if (spec === undefined || !ts.isObjectLiteralExpression(spec)) return undefined;
    for (const property of spec.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== "source") continue;
      const value = property.initializer;
      if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "DECISION_SOURCES") {
        return value.name.text in DECISION_SOURCES ? value.name.text : undefined;
      }
    }
    return undefined;
  };
  const visit = (node: ts.Node, insideJournaled: boolean): void => {
    let inside = insideJournaled;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "journaledPick") {
        audit.journaled.push({ source: sourceOf(node) });
        for (const id of literals(node)) if (PERMISSION_IDS.has(id)) audit.permissionIdsInsideJournaled.push(id);
        inside = true;
      } else if (name === "showComposerChoice") {
        const ids = literals(node);
        if (ids.some((id) => PERMISSION_IDS.has(id) || id === "permissionMode")) {
          audit.permissionPickers += 1;
          if (insideJournaled) audit.wrappedPermissionPickers.push(node.getText(file).slice(0, 60));
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(file, false);
  return audit;
}

describe("wiring: which pickers are journaled and which are not", () => {
  const read = (file: string): Promise<string> => readFile(path.join(import.meta.dir, "..", file), "utf8");

  test("tui-shell journals exactly the work pickers (wiki enrich, queue routing, held session), each with a known source", async () => {
    const audit = auditPickers(await read("tui/tui-shell.ts"));
    expect(audit.journaled).toHaveLength(3);
    // every journaledPick call names its source as a DECISION_SOURCES member, never a free string or a variable
    for (const call of audit.journaled) expect(call.source).toBeDefined();
    expect(new Set(audit.journaled.map((call) => call.source))).toEqual(new Set(["wikiEnrich", "queueRoute", "sessionLease"]));
    for (const call of audit.journaled) expect(Object.keys(DECISION_SOURCES)).toContain(call.source as string);
    expect(new Set(audit.journaled.map((call) => call.source)).size).toBe(audit.journaled.length);
  });

  test("no allow/deny or permission-mode picker is wrapped in journaledPick, and none of their ids appear inside one", async () => {
    const audit = auditPickers(await read("tui/tui-shell.ts"));
    // the detector must not go blind: shell command, patch, subagent (x2 modes), external agent, ... and the mode picker
    expect(audit.permissionPickers).toBeGreaterThanOrEqual(7);
    expect(audit.wrappedPermissionPickers).toEqual([]);
    expect(audit.permissionIdsInsideJournaled).toEqual([]);
  });

  test("the audit catches a permission picker wrapped in journaledPick (scratch-copy mutation of the real source)", async () => {
    const shell = await read("tui/tui-shell.ts");
    const needle = "const id = await showComposerChoice(otui, r, dock, {\n    title: credentials";
    expect(shell).toContain(needle);
    // wrap the shell-command allow/deny picker the way a careless change would
    const mutated = shell.replace(
      needle,
      "const id = await journaledPick(sessionCwd, { source: DECISION_SOURCES.queueRoute, question: 'x', options: [], cancelId: 'deny' }, (_options, dismissId) => showComposerChoice(otui, r, dock, {\n    title: credentials",
    );
    expect(mutated).not.toBe(shell);
    const audit = auditPickers(mutated);
    expect(audit.wrappedPermissionPickers.length).toBeGreaterThan(0);
    expect(audit.permissionIdsInsideJournaled.length).toBeGreaterThan(0);
    // and a journaledPick with a source that is no DECISION_SOURCES member is seen
    const loose = auditPickers(shell.replace("source: DECISION_SOURCES.wikiEnrich", "source: 'free-text'"));
    expect(loose.journaled.some((call) => call.source === undefined)).toBe(true);
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

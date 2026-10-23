// Flow 464 (AC6): the Telegram review cards show where the operator already looks — the Remote sidebar row, the
// /remote-control status tab and the /decisions modal — with the age and the time left of the 1-hour token while a
// card waits, and who pressed once it is answered. The help modal and the slash command list name the card tools.

import { expect, test } from "bun:test";
import { commandsForMode } from "../commands/agent-commands";
import { REMOTE_CARD_TTL_MS } from "../commands/operator-confirm-tools";
import { HELP_GROUPS } from "../standard/help-groups";
import { presentDecisions, withConfirmationLines } from "./decisions-surface";
import { OperatorConfirmationLog, answeredConfirmationLine, confirmationLines, pendingConfirmationLine, waitingCardsText } from "./operator-confirmations";
import { formatRemoteStatusLines, projectRemoteRow } from "./remote-control-surface";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const CARD_TOOLS = ["review_confirm_plan", "review_decide_premise", "review_waive_readiness", "review_waive_coverage", "review_complete"];

function logAt(clock: { now: number }): OperatorConfirmationLog {
  return new OperatorConfirmationLog(() => clock.now);
}

test("a waiting card shows its question, its age and the time left of the 1-hour token", () => {
  const clock = { now: T0 };
  const log = logAt(clock);
  log.ask("Complete review 2026-10-18-x?", true);
  clock.now = T0 + 3 * 60_000;
  const [entry] = log.entries();
  expect(pendingConfirmationLine(entry!, clock.now)).toBe("Complete review 2026-10-18-x? · asked 3m ago · 57m left of the 1-hour token");
});

test("a card past the token says it expired", () => {
  const log = logAt({ now: T0 });
  log.ask("Confirm the plan?", true);
  const [entry] = log.entries();
  expect(pendingConfirmationLine(entry!, T0 + REMOTE_CARD_TTL_MS + 1000)).toContain("Telegram token expired, answer in the shell");
});

test("a card past the token no longer counts as waiting in the topic", () => {
  const clock = { now: T0 };
  const log = logAt(clock);
  log.ask("Confirm the plan?", true);
  clock.now = T0 + REMOTE_CARD_TTL_MS;
  expect(log.waiting()).toHaveLength(1);
  clock.now = T0 + REMOTE_CARD_TTL_MS + 1;
  expect(log.waiting()).toHaveLength(0);
  expect(log.entries()).toHaveLength(1);
});

test("a card logged as mirrored that the topic never took is marked undelivered and stops waiting there", () => {
  const log = logAt({ now: T0 });
  let changes = 0;
  const id = log.ask("Confirm the plan?", true);
  log.subscribe(() => {
    changes += 1;
  });
  expect(log.waiting()).toHaveLength(1);
  log.markUndelivered(id);
  expect(log.waiting()).toHaveLength(0);
  expect(pendingConfirmationLine(log.entries()[0]!, T0)).toContain("Telegram mirror not delivered, answer in the shell");
  expect(changes).toBe(1);
  log.markUndelivered(id);
  expect(changes).toBe(1);
  log.answer(id, { place: "shell", yes: true });
  log.markUndelivered(id);
  expect(log.entries()[0]!.answered?.place).toBe("shell");
});

test("a card the topic leg gave up on after posting stops waiting there, with its own wording", () => {
  const log = logAt({ now: T0 });
  const id = log.ask("Confirm the plan?", true);
  log.markUndelivered(id, "ended");
  expect(log.waiting()).toHaveLength(0);
  const line = pendingConfirmationLine(log.entries()[0]!, T0);
  expect(line).toContain("Telegram is no longer waiting for this card, answer in the shell");
  expect(line).not.toContain("not delivered");
});

test("a card whose mirror was not delivered says it must be answered in the shell", () => {
  const log = logAt({ now: T0 });
  log.ask("Confirm the plan?", false);
  const [entry] = log.entries();
  expect(pendingConfirmationLine(entry!, T0)).toContain("Telegram mirror not delivered, answer in the shell");
  expect(log.waiting()).toHaveLength(0);
});

test("an answered card shows who pressed it", () => {
  const clock = { now: T0 };
  const log = logAt(clock);
  const id = log.ask("Complete review X?", true);
  clock.now = T0 + 11_000;
  log.answer(id, { place: "telegram", yes: true, pressedBy: 9 });
  const [entry] = log.entries();
  expect(answeredConfirmationLine(entry!)).toBe("Complete review X? · yes · pressed by Telegram user 9 at 12:00:11");
  expect(log.waiting()).toHaveLength(0);
});

test("a card answered in the shell or withdrawn names that, never a Telegram user", () => {
  const log = logAt({ now: T0 });
  const a = log.ask("A?", true);
  const b = log.ask("B?", true);
  log.answer(a, { place: "shell", yes: false });
  log.answer(b, { place: "withdrawn", yes: false });
  const lines = log.entries().map(answeredConfirmationLine).join("\n");
  expect(lines).toContain("A? · no · answered in the shell");
  expect(lines).toContain("B? · withdrawn (the turn stopped)");
  expect(lines).not.toContain("pressed by");
});

test("the section lists waiting cards first, then answered ones; with no cards it is empty", () => {
  expect(confirmationLines([], T0)).toEqual([]);
  const log = logAt({ now: T0 });
  const done = log.ask("Old?", true);
  log.answer(done, { place: "telegram", yes: true, pressedBy: 4 });
  log.ask("New?", true);
  const lines = confirmationLines(log.entries(), T0);
  expect(lines[0]).toBe("Operator confirmations (Telegram cards)");
  expect(lines[1]).toMatch(/^ {2}waiting {2}New\?/);
  expect(lines[2]).toMatch(/^ {2}answered Old\? · yes · pressed by Telegram user 4/);
});

test("the log keeps only the last few answered cards, and notifies on every change", () => {
  const log = logAt({ now: T0 });
  let changes = 0;
  log.subscribe(() => {
    changes += 1;
  });
  for (let i = 0; i < 8; i += 1) log.answer(log.ask(`Q${i}?`, true), { place: "shell", yes: true });
  expect(log.entries()).toHaveLength(5);
  expect(log.entries()[0]!.question).toBe("Q7?");
  expect(changes).toBe(16);
});

test("the sidebar Remote row counts the cards waiting", () => {
  expect(waitingCardsText(0)).toBeUndefined();
  expect(waitingCardsText(1)).toBe("1 card waiting");
  expect(waitingCardsText(3)).toBe("3 cards waiting");
  const row = projectRemoteRow({ state: "on", name: "keryx-demo", events: [] }, SIDEBAR_TEXT_WIDTH, 2);
  expect(row.text).toContain("2 cards waiting");
  expect(row.role).toBe("attention");
  expect(projectRemoteRow({ state: "on", name: "keryx-demo", events: [] }, SIDEBAR_TEXT_WIDTH).text).toBe("keryx-demo");
});

test("the /remote-control status tab carries the cards, and stays as before without any", () => {
  const status = { state: "on", name: "keryx-demo", heartbeatAgeMs: 1000, events: [] } as const;
  const log = logAt({ now: T0 });
  log.ask("Complete review X?", true);
  const withCards = formatRemoteStatusLines(status, undefined, confirmationLines(log.entries(), T0 + 60_000));
  expect(withCards.join("\n")).toContain("Operator confirmations (Telegram cards)");
  expect(withCards.join("\n")).toContain("Complete review X? · asked 1m ago · 59m left of the 1-hour token");
  expect(formatRemoteStatusLines(status, undefined, [])).toEqual(formatRemoteStatusLines(status));
});

test("the /decisions modal prints the cards under the report", () => {
  const log = logAt({ now: T0 });
  log.answer(log.ask("Confirm the plan?", true), { place: "telegram", yes: true, pressedBy: 7 });
  const text = withConfirmationLines("By stage:\n  ordinary", confirmationLines(log.entries(), T0));
  expect(withConfirmationLines("By stage:", [])).toBe("By stage:");

  let painted = "";
  class FakeText {
    content: string;
    constructor(_r: unknown, opts: { content: string }) {
      this.content = opts.content;
      painted = opts.content;
    }
  }
  const open = ((_otui: unknown, _chrome: unknown, input: { renderTab?: (id: string, body: unknown, ctx?: unknown) => void }) => {
    input.renderTab?.("report", { add: () => undefined }, undefined);
    return { close: () => undefined };
  }) as never;
  expect(presentDecisions(open, { TextRenderable: FakeText }, {}, { text, visibleRows: 40 })).toBeDefined();
  expect(painted).toContain("By stage:");
  expect(painted).toContain("Operator confirmations (Telegram cards)");
  expect(painted).toContain("pressed by Telegram user 7");
});

test("the help modal and the command list name the card tools", () => {
  const help = HELP_GROUPS.filter((entry) => entry.name === "/remote-control" || entry.name === "/decisions");
  expect(help).toHaveLength(2);
  const commands = commandsForMode("agent").filter((command) => command.name === "/remote-control" || command.name === "/decisions");
  expect(commands).toHaveLength(2);
  for (const tool of CARD_TOOLS) {
    for (const entry of help) expect(entry.summary).toContain(tool);
    for (const command of commands) expect(command.description).toContain(tool);
  }
});

test("a mirrored card is settled from how the race ended: dock, topic press, aborted turn, or a race that threw", () => {
  const log = logAt({ now: T0 });
  const settled = (outcome: Parameters<OperatorConfirmationLog["settle"]>[1], aborted = false) => {
    const id = log.ask("Q?", true);
    log.settle(id, outcome, aborted);
    return log.entries().find((entry) => entry.id === id)!.answered!;
  };
  expect(settled({ from: "dock", result: true })).toMatchObject({ place: "shell", yes: true });
  expect(settled({ from: "dock", result: false })).toMatchObject({ place: "shell", yes: false });
  expect(settled({ from: "dock", result: false }, true)).toMatchObject({ place: "withdrawn", yes: false });
  expect(settled({ from: "topic", answer: { decision: "allow", fromId: 9 } })).toMatchObject({ place: "telegram", yes: true, pressedBy: 9 });
  expect(settled({ from: "topic", answer: { decision: "deny" } })).toEqual(expect.objectContaining({ place: "telegram", yes: false }));
  expect(settled(undefined)).toMatchObject({ place: "withdrawn", yes: false });
  expect(log.waiting()).toHaveLength(0);
});

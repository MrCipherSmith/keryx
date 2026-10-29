import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerDecision, openDecision } from "../../decisions/journal";
import { readRecords } from "../../decisions/store";
import { runDecisionsFollowup } from "../../tui/decisions-surface";
import { createNativeQuestionJournal } from "../question-journal";
import { decisionFollowupCommands, executeDecisionFollowup } from "./decision-followups";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function answered(choice: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-native-followup-")); roots.push(cwd);
  expect(await Bun.spawn(["git", "init", "-q", cwd], { env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).exited).toBe(0);
  const journal = createNativeQuestionJournal({ cwd, session: "hub-session", admissible: () => true, notify: () => {}, note: () => {},
    ask: async () => ({ kind: "option", choice }) });
  await journal.ask({ question: "Proceed with the parity fixture?", recommendationReason: "Yes is the planned path.",
    options: [{ id: "yes", label: "Yes", description: "Go on", recommended: true }, { id: "no", label: "No", description: "Stop" }] });
  return { cwd, journal: { session: journal.session, lastDecisionId: journal.lastDecisionId }, id: journal.lastDecisionId()! };
}

test("decisions.reason and decisions.change act on this session's latest answered decision with the TUI's own words", async () => {
  const { cwd, journal, id } = await answered("no");
  expect(await executeDecisionFollowup({ cwd, decisionJournal: journal }, "decisions.reason", { text: "the fixture said so" }))
    .toEqual({ ok: true, source: "local-native", data: { decisionId: id, text: `Reason recorded for decision ${id} ("Proceed with the parity fixture?").` } });
  const changed = await executeDecisionFollowup({ cwd, decisionJournal: journal }, "decisions.change", { choice: "Yes" });
  // The same line the TUI prints for the same follow-up (its transcript adds only the marker).
  const twin = await answered("no"); const notices: string[] = [];
  await runDecisionsFollowup({ kind: "change", choice: "Yes" }, { cwd: twin.cwd, lastDecisionId: twin.journal.lastDecisionId, session: twin.journal.session, notice: (text) => notices.push(text) });
  expect(changed.ok && (changed.data as { text: string }).text.replaceAll(id, "<id>")).toBe(notices[0]!.replaceAll(twin.id, "<id>"));
  expect((await readRecords(cwd)).filter((record) => record.kind === "answer").map((record) => record.kind === "answer" && record.choice)).toEqual(["no", "yes"]);
});

test("a follow-up keeps the journal's own decision id whole in its words while the redaction still cuts the question", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-native-followup-")); roots.push(cwd);
  expect(await Bun.spawn(["git", "init", "-q", cwd], { env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).exited).toBe(0);
  // A generated id whose base-36 time ends in digits and whose hex tail is all digits reads as a phone number to the redaction.
  const id = "d-mvtgj271-721701";
  await openDecision({ cwd, id, session: "hub-session", channel: "hub", question: "Call 555 123 4567 before the parity fixture?", reasonPrompt: false, arm: "A", salt: "native-followup-test-salt",
    options: [{ id: "yes", label: "Yes", description: "Go on" }, { id: "no", label: "No", description: "Stop" }], recommendation: { optionId: "yes", reason: "The planned path." } });
  await answerDecision({ cwd, id, choice: "no" });
  const journal = { session: "hub-session", lastDecisionId: () => id };
  for (const [command, input, lead] of [["decisions.reason", { text: "the fixture said so" }, `decision ${id} (`], ["decisions.change", { choice: "yes" }, `Decision ${id} (`]] as const) {
    const done = await executeDecisionFollowup({ cwd, decisionJournal: journal }, command, input);
    expect(done).toMatchObject({ ok: true, data: { decisionId: id } });
    const text = done.ok ? done.data.text : "";
    expect({ id: text.includes(lead), phone: text.includes("555 123 4567"), redacted: text.includes("[REDACTED:phone]") }).toEqual({ id: true, phone: false, redacted: true });
  }
});

test("a follow-up the journal refuses changes nothing and says why; without a journal nothing is attempted", async () => {
  const { cwd, journal } = await answered("yes");
  const before = (await readRecords(cwd)).length;
  // The recommendation was followed: there is no deviation to explain (the TUI's refusal), and an unknown option is refused too.
  expect(await executeDecisionFollowup({ cwd, decisionJournal: journal }, "decisions.reason", { text: "why" })).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringContaining("no deviation to explain") } });
  expect(await executeDecisionFollowup({ cwd, decisionJournal: journal }, "decisions.change", { choice: "maybe" })).toMatchObject({ ok: false, error: { code: "refused", message: expect.stringContaining("is not one of the options") } });
  // Another session's journal identity never reaches this decision.
  expect(await executeDecisionFollowup({ cwd, decisionJournal: { session: "other", lastDecisionId: () => undefined } }, "decisions.change", { choice: "no" })).toMatchObject({ ok: false, error: { code: "refused" } });
  expect((await readRecords(cwd)).length).toBe(before);
  expect(await executeDecisionFollowup({ cwd }, "decisions.change", { choice: "no" })).toMatchObject({ ok: false, error: { code: "implementation-gap" } });
  expect(await executeDecisionFollowup({ cwd, decisionJournal: journal }, "decisions.reason", { text: "" })).toMatchObject({ ok: false, error: { code: "refused" } });
  expect(await executeDecisionFollowup({ cwd, decisionJournal: journal }, "decisions.reason", { why: "x" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
});

test("the follow-ups are idle session-class journal writes with no confirmation, as the TUI asks none", () => {
  for (const { entry } of decisionFollowupCommands()) expect(entry).toMatchObject({ mutationClass: "session", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available" });
  expect(decisionFollowupCommands().map(({ entry }) => entry.commandName)).toEqual(["decisions.reason", "decisions.change"]);
});

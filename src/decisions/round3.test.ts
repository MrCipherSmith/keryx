// Flow 392, review round 3 on PR #856: the widened strong terms, the ask_user
// action / irreversible input, ambiguity failing towards non-blind, the visible
// count of refused-blind questions, and the session check on `/decisions change`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { runDecisionsFollowup } from "../tui/decisions-surface";
import { DEFAULT_IRREVERSIBLE, isIrreversible } from "./blind";
import { renderReport } from "./report";
import { answerDecision, changeAnswer, giveReason, journalAsk, loadReport, openDecision } from "./service";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-r3-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const list = [...DEFAULT_IRREVERSIBLE];
const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
];
const withRec = (): Array<(typeof OPTIONS)[number] & { recommended?: boolean }> => OPTIONS.map((o, i) => ({ ...o, ...(i === 0 ? { recommended: true } : {}) }));
const rec = { optionId: "a", reason: "" };

describe("F-001: the real synonyms of releasing are strong terms", () => {
  test.each([
    ["Выпустить версию 1.4?"],
    ["Выпускаем новую версию?"],
    ["Ship 1.4 to npm?"],
    ["Ship it?"],
    ["Отправить в прод?"],
    ["Отправим на продакшн?"],
    ["Залить в мастер?"],
    ["Залей это в main?"],
    ["Накатить миграцию?"],
    ["Накатываем обновление?"],
    ["Roll out the new build?"],
    ["Rollout to all users?"],
    ["Promote this build?"],
    ["Go live on Friday?"],
    ["Tag v1.4.0 and cut it?"],
    ["Поставить тег на версию?"],
    ["Тегнуть v2.0.1?"],
    ["Publish to npm?"],
    ["Upload the package to npm?"],
    ["Залить пакет в npm?"],
  ])("%s", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test("an option can carry it", () => {
    expect(isIrreversible(list, "Which way?", undefined, [{ id: "x", label: "Ship it" }, { id: "y", label: "Wait" }])).toBe(true);
  });

  test.each([
    ["Should the tag input accept spaces?"],
    ["Is the relationship between the two tables modelled right?"],
    ["Which prod-like fixture should the test use?"],
    ["Выбрать продукт для примера?"],
    ["Использовать main.ts как точку входа?"],
  ])("a nearby ordinary question stays ordinary: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(false);
  });
});

describe("F-001: ask_user can say it outright", () => {
  const draw = (): number => 0;

  test("irreversible: true, or any action tag, is never blind", async () => {
    for (const extra of [{ irreversible: true }, { action: "release" }, { action: "cut-the-thing" }]) {
      const shown: Array<{ ids: string[]; marked: boolean }> = [];
      const ask = journalAsk(
        async (request) => (shown.push({ ids: request.options.map((o) => o.id), marked: request.options.some((o) => o.recommended === true) }), "a"),
        { cwd: root, random: draw },
      );
      await ask({ question: "Which colour is nicer?", options: withRec(), ...extra });
      expect(shown[0]).toEqual({ ids: ["a", "b"], marked: true });
    }
    const opens = (await readRecords(root)).filter((r) => r.kind === "open");
    expect(opens).toHaveLength(3);
    for (const open of opens) expect(open).toMatchObject({ mode: "ordinary", irreversible: true, blindRefused: true });
    expect(opens[1]).toMatchObject({ action: "release" });
  });

  test("the same question without either can be blind", async () => {
    const ask = journalAsk(async () => "a", { cwd: root, random: draw });
    await ask({ question: "Which colour is nicer?", options: withRec() });
    expect((await readRecords(root)).find((r) => r.kind === "open")).toMatchObject({ mode: "blind", irreversible: false });
  });

  test("the CLI path: openDecision with irreversible or any action tag is never blind", async () => {
    for (const extra of [{ irreversible: true }, { action: "whatever" }]) {
      const opened = await openDecision({ cwd: root, question: "Pick a colour?", options: OPTIONS, recommendation: rec, random: draw, ...extra });
      expect(opened).toMatchObject({ mode: "ordinary", irreversible: true, blindRefused: true });
    }
  });
});

describe("F-002: ambiguity fails towards non-blind", () => {
  test.each([
    ["Merge it now?"],
    ["Merge it?"],
    ["Merge?"],
    ["Merge now?"],
    ["Drop it?"],
    ["Force it?"],
    ["Remove this?"],
    ["Reset everything?"],
    ["Слить это?"],
    ["Слей его сейчас?"],
    ["Merge the PR?"],
    ["Merge the pull request?"],
    ["Drop the commit?"],
    ["Remove the branch?"],
    ["git reset --hard"],
    ["Run git reset --hard HEAD~1?"],
    ["reset --hard to origin?"],
    ["git clean -fd?"],
    ["Run clean -f?"],
    ["git checkout -- src/app.ts?"],
    ["checkout --force?"],
    ["rm -rf build?"],
    ["Run rm -rf node_modules?"],
    ["git branch -D old?"],
    ["push --force-with-lease?"],
  ])("%s", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test.each([
    ["Merge this helper into that one?"],
    ["Merge these two hooks into one?"],
    ["Merge the two date helpers into one?"],
    ["Drop the unused import in utils.ts?"],
    ["Remove the dead code in the parser?"],
    ["Force a type here?"],
    ["Force the return value to a string type?"],
    ["Reset the form state when the dialog closes?"],
    ["Send the debounced value to the child component?"],
    ["Слить две вспомогательные функции в одну?"],
    ["Убрать неиспользуемый импорт?"],
    ["Rename the variable count to total?"],
    ["Remove the redundant null check?"],
    ["Is the original implementation of sort stable enough?"],
  ])("the ordinary corpus stays ordinary: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(false);
  });
});

describe("F-003: code identifiers are not actions, and refused-blind is counted", () => {
  test.each([
    ["Rename deleteUser to removeUser?"],
    ["Rename `deleteUser` to `removeUser`?"],
    ["Rename the function pushState to updateState?"],
    ["Переименовать функцию deleteUser в removeUser?"],
    ["Extract publishEvent into its own function?"],
  ])("a code identifier in a question about code does not count: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(false);
  });

  test.each([
    ["Delete the user?"],
    ["Delete deleteUser from the database?"],
    ["Run deployToProd now?"],
    ["Rename and then delete the old backups?"],
    ["Deploy the build?"],
    ["Release 1.4 today?"],
    ["Push the fix?"],
  ])("the allowance does not weaken the real cases: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test("the report counts the questions asked non-blind because they looked irreversible, per stage", async () => {
    const open = (question: string, stage: string): Promise<unknown> =>
      openDecision({ cwd: root, question, options: OPTIONS, recommendation: rec, stage, random: () => 0 });
    await open("Release 1.4?", "release");
    await open("Deploy the build?", "release");
    await open("Delete the old backups?", "cleanup");
    await open("Which colour is nicer?", "design"); // blind, not refused

    const report = await loadReport(root);
    expect(report.blindRefused).toBe(3);
    expect(report.irreversible).toBe(3);
    const stage = (name: string) => report.byStage.find((row) => row.stage === name);
    expect(stage("release")?.blindRefused).toBe(2);
    expect(stage("cleanup")?.blindRefused).toBe(1);
    expect(stage("design")).toBeUndefined(); // nothing answered, nothing refused: no row

    const text = renderReport(report);
    expect(text).toContain("Looked irreversible: 3.");
    expect(text).toContain("Blind refused because of it: 3");
    expect(text).toMatch(/release: ordinary n\/a, blind n\/a, blind refused 2/);
    expect(text).toMatch(/cleanup: ordinary n\/a, blind n\/a, blind refused 1/);
    expect(text).not.toMatch(/design: .*blind refused/);
  });

  test("an old record without the flag counts as not refused", async () => {
    await mkdir(path.join(root, ".metaproject", "data", "decisions"), { recursive: true });
    const line = JSON.stringify({
      kind: "open",
      id: "d-old",
      at: "2026-10-01T00:00:00Z",
      flow: null,
      stage: "old",
      question: "Release?",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      recommendation: rec,
      mode: "ordinary",
      order: ["a", "b"],
      showMark: true,
      irreversible: true,
    });
    await writeFile(path.join(root, ".metaproject", "data", "decisions", "journal.jsonl"), `${line}\n`, "utf8");
    expect(await loadReport(root)).toMatchObject({ irreversible: 1, blindRefused: 0 });
  });
});

describe("F-004: /decisions change without an id stays inside this session", () => {
  async function git(...args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }

  async function inProgressFlow(): Promise<string> {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    const service = createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") });
    const created = await service.init({ cwd: root, title: "Session flow" });
    const file = path.join(root, created.dir, "flow.json");
    const flow = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...flow, status: "in-progress" }, null, 2), "utf8");
    return created.flow.id;
  }

  async function askedBy(session: string | undefined, id: string, flow: string): Promise<void> {
    await openDecision({ cwd: root, question: `Question ${id}`, options: OPTIONS, recommendation: rec, flow, session, id, random: () => 0.9 });
    await answerDecision({ cwd: root, id, choice: "b" });
  }

  test("a decision of another session found through the flow is refused, and named", async () => {
    await askedBy("s-other", "d-theirs", "007");
    const before = (await readRecords(root)).length;
    await expect(changeAnswer({ cwd: root, choice: "a", flow: "007", session: "s-mine" })).rejects.toThrow(/d-theirs.*Question d-theirs.*not asked in this session.*nothing was changed/);
    await expect(giveReason({ cwd: root, text: "x", flow: "007", session: "s-mine" })).rejects.toThrow(/d-theirs.*not asked in this session/);
    expect((await readRecords(root)).length).toBe(before);
  });

  test("a decision with no recorded session (an older record) is not this session's either", async () => {
    await askedBy(undefined, "d-old", "007");
    await expect(changeAnswer({ cwd: root, choice: "a", flow: "007", session: "s-mine" })).rejects.toThrow(/d-old.*not asked in this session/);
  });

  test("this session's own decision is changed, and a named id is still honoured", async () => {
    await askedBy("s-mine", "d-mine", "007");
    await askedBy("s-other", "d-theirs", "007");
    expect(await changeAnswer({ cwd: root, choice: "a", lastId: "d-mine", flow: "007", session: "s-mine" })).toMatchObject({ id: "d-mine", previous: "b" });
    // a deliberate id is the human's own choice
    expect(await changeAnswer({ cwd: root, choice: "a", id: "d-theirs", session: "s-mine" })).toMatchObject({ id: "d-theirs" });
  });

  test("a lastId that carries another session's decision is refused when the session is known", async () => {
    await askedBy("s-other", "d-theirs", "007");
    await expect(changeAnswer({ cwd: root, choice: "a", lastId: "d-theirs", session: "s-mine" })).rejects.toThrow(/not asked in this session/);
  });

  test("the journal records the session on the open record", async () => {
    const ask = journalAsk(async () => "b", { cwd: root, random: () => 0.9, session: "s-123" });
    await ask({ question: "Pick", options: withRec() });
    expect((await readRecords(root)).find((r) => r.kind === "open")).toMatchObject({ session: "s-123" });
  });

  test("the TUI path: an inferred flow's decision from another session is named and left alone", async () => {
    const flow = await inProgressFlow();
    await askedBy("s-other", "d-theirs", flow);
    const said: string[] = [];
    const deps = { cwd: root, lastDecisionId: () => undefined, session: "s-mine", notice: (text: string) => said.push(text) };
    await runDecisionsFollowup({ kind: "change", choice: "a" }, deps);
    await runDecisionsFollowup({ kind: "reason", text: "because" }, deps);
    expect(said).toHaveLength(2);
    for (const text of said) {
      expect(text).toContain("d-theirs");
      expect(text).toContain("not asked in this session");
    }
    expect((await readRecords(root)).filter((r) => r.kind === "answer")).toHaveLength(1);
    expect((await readRecords(root)).filter((r) => r.kind === "reason")).toHaveLength(0);
  });
});

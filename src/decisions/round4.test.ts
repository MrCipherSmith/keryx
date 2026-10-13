// Flow 392, review round 4 on PR #856: cut / bump / tag phrasing is a release, and a
// flow that was only inferred never gets a line in its own journal.md.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { DEFAULT_IRREVERSIBLE, isIrreversible } from "./blind";
import { answerDecision, openDecision, resolveFlowContext } from "./service";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-r4-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const list = [...DEFAULT_IRREVERSIBLE];
const OPTIONS = [
  { id: "a", label: "Option A" },
  { id: "b", label: "Option B" },
];
const rec = { optionId: "a", reason: "" };

describe("r04 F-001: cutting, bumping and tagging a version is a release", () => {
  test.each([
    ["Cut 0.3.62?"],
    ["Cut v1.4?"],
    ["Cut a release?"],
    ["Cut the version now?"],
    ["Bump the version and tag it?"],
    ["Bump version?"],
    ["Bump the minor?"],
    ["Bump to 1.2.3?"],
    ["Tag it?"],
    ["Tag this?"],
    ["Cut a tag?"],
    ["Версию поднять и затегать?"],
    ["Поднять версию?"],
    ["Повысить версию до 2.0?"],
    ["Затегать?"],
    ["Тегнуть это?"],
    ["Зарелизить?"],
    ["Зарелизим сегодня?"],
    ["Релизнуть?"],
    ["Релизнём пакет?"],
  ])("%s", (question) => {
    expect(isIrreversible(list, question)).toBe(true);
  });

  test("an option can carry it", () => {
    expect(isIrreversible(list, "Which way?", undefined, [{ id: "x", label: "Cut 0.3.62" }, { id: "y", label: "Wait" }])).toBe(true);
  });

  test.each([
    ["Cut the cache ttl to 0.5 seconds?"],
    ["Cut the function into two smaller ones?"],
    ["Should the tag input accept spaces?"],
    ["Is the bumper style of the card too heavy?"],
    ["Which version of the type guard reads clearer?"],
    ["Тестовые файлы класть рядом с кодом или в отдельную папку?"],
    ["Переименовать переменную или оставить как есть?"],
    ["Merge these two React components into one?"],
    ["Drop the legacy fallback in the formatter?"],
  ])("a nearby ordinary question stays ordinary: %s", (question) => {
    expect(isIrreversible(list, question)).toBe(false);
  });
});

describe("r02 F-006: an inferred flow is never written into the flow's own journal.md", () => {
  async function git(...args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }

  async function newFlow(): Promise<{ id: string; journal: string }> {
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    const service = createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") });
    const created = await service.init({ cwd: root, title: "Inferred flow" });
    const file = path.join(root, created.dir, "flow.json");
    const flow = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...flow, status: "in-progress" }, null, 2), "utf8");
    return { id: created.flow.id, journal: path.join(root, created.dir, "journal.md") };
  }

  async function journalText(file: string): Promise<string> {
    try {
      return await readFile(file, "utf8");
    } catch {
      return "";
    }
  }

  async function decide(flow: string, flowSource: "env" | "branch" | "inferred" | undefined, id: string): Promise<void> {
    await openDecision({ cwd: root, question: `Question ${id}`, options: OPTIONS, recommendation: rec, flow, flowSource, id, arm: "A" });
    await answerDecision({ cwd: root, id, choice: "b" });
  }

  test("inferred: the project journal keeps the record with its flag, the flow's journal.md gets nothing", async () => {
    const flow = await newFlow();
    const resolved = await resolveFlowContext(root, {});
    expect(resolved).toMatchObject({ flow: flow.id, flowSource: "inferred" });
    const before = await journalText(flow.journal);
    await decide(flow.id, "inferred", "d-guess");
    expect(await journalText(flow.journal)).toBe(before);
    expect(await journalText(flow.journal)).not.toContain("d-guess");
    const records = await readRecords(root);
    expect(records.find((r) => r.kind === "open")).toMatchObject({ id: "d-guess", flow: flow.id, flowSource: "inferred" });
    expect(records.filter((r) => r.kind === "answer")).toHaveLength(1);
  });

  test("env, branch and an explicit flow still write their line", async () => {
    const flow = await newFlow();
    await decide(flow.id, "env", "d-env");
    await decide(flow.id, "branch", "d-branch");
    await decide(flow.id, undefined, "d-explicit");
    const text = await journalText(flow.journal);
    for (const id of ["d-env", "d-branch", "d-explicit"]) expect(text).toContain(`decision ${id}`);
  });
});

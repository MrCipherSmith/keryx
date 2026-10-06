// Flow 403: shared test support for work intake. Everything runs with NO live anything:
// a throwaway project root, HOME and XDG_* pointed away from the developer's, a fake `gh`
// (a `GhRunner` answering from fixtures and recording every call), a fake Telegram sink,
// a scripted model, a registered fake board reader, and a clock the test moves by hand.

import { setSystemTime } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerBoardReader, type BoardSource } from "../scheduler/digest-board";
import type { GhCall, GhResult, GhRunner } from "../scheduler/digest-gh";
import { runIntakePoll, type IntakeDeps } from "./poll";
import type { IntakeAssessInput, IntakeAssessResult, IntakeCardSink, IntakeCardView, IntakeConfig, IntakePollResult, IntakeSendResult } from "./types";
import { DEFAULT_INTAKE_CONFIG } from "./config";

export const REPO = "MrCipherSmith/keryx";
export const OTHER_REPO = "MrCipherSmith/other";

export class TestClock {
  private ms: number;
  constructor(start: Date) {
    this.ms = start.getTime();
  }
  now = (): Date => new Date(this.ms);
  set(at: Date): void {
    this.ms = at.getTime();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Local-time constructor, so quiet hours do not depend on the timezone of the machine running the tests. */
export const local = (h: number, min = 0, day = 5): Date => new Date(2026, 9, day, h, min, 0);

export interface IntakeTestEnv {
  readonly root: string;
  readonly aside: string;
  readonly ghBin: string;
  /** The environment a poll runs with: a PATH whose first `gh` is the stub, and a private runtime dir. */
  readonly env: Record<string, string | undefined>;
  readonly logged: string[];
  setBoard(entries: readonly { id: string; title: string; status: string; closedAt?: string | null; verdict?: string }[] | "absent"): void;
  teardown(): Promise<void>;
}

export async function setupIntakeEnv(options: { config?: Partial<IntakeConfig> } = {}): Promise<IntakeTestEnv> {
  const saved = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };
  const home = await mkdtemp(path.join(tmpdir(), "keryx-intake-home-"));
  process.env["HOME"] = home;
  process.env["XDG_DATA_HOME"] = path.join(home, ".local", "share");
  const root = await mkdtemp(path.join(tmpdir(), "keryx-intake-root-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const aside = await mkdtemp(path.join(tmpdir(), "keryx-intake-aside-"));
  const runtime = path.join(aside, "run");
  await mkdir(runtime, { mode: 0o700 });
  const ghBin = path.join(aside, "gh");
  await writeFile(ghBin, "#!/bin/sh\necho '[]'\n", "utf8");
  await chmod(ghBin, 0o755);
  if (options.config !== undefined) {
    await mkdir(path.join(root, ".metaproject", "data", "intake"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "data", "intake", "config.json"), JSON.stringify({ ...DEFAULT_INTAKE_CONFIG, enabled: true, repos: [REPO], ...options.config }), "utf8");
  }
  const logged: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  process.exitCode = 0;
  // A card has an expiry measured from the wall clock; pin it so the suite does not depend on the date it runs on.
  setSystemTime(local(10, 30));
  const env: Record<string, string | undefined> = {
    PATH: `${aside}${path.delimiter}${process.env["PATH"] ?? ""}`,
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
  };
  setBoardReader("absent");
  return {
    root,
    aside,
    ghBin,
    env,
    logged,
    setBoard: (entries) => setBoardReader(entries),
    teardown: async () => {
      registerBoardReader(undefined);
      setSystemTime();
      console.log = realLog;
      console.error = realError;
      process.exitCode = 0;
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
      await rm(aside, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

export function setBoardReader(entries: readonly { id: string; title: string; status: string; closedAt?: string | null; verdict?: string }[] | "absent"): void {
  registerBoardReader(async (): Promise<BoardSource> => {
    if (entries === "absent") return { state: "absent" };
    return { state: "present", entries: entries.map((e) => ({ id: e.id, title: e.title, status: e.status, closedAt: e.closedAt ?? null, verdict: e.verdict ?? "" })), chains: [] };
  });
}

// ---- gh fixtures -------------------------------------------------------------------

export function issuesJson(rows: readonly { number: number; title?: string; updatedAt: string; body?: string }[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      number: r.number,
      title: r.title ?? `Issue ${r.number}`,
      author: { login: "bob" },
      labels: [],
      updatedAt: r.updatedAt,
      url: `https://github.com/${repo}/issues/${r.number}`,
      body: r.body ?? `Body of issue ${r.number}`,
    })),
  );
}

export function reviewsJson(rows: readonly { number: number; title?: string; updatedAt: string }[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      number: r.number,
      title: r.title ?? `PR ${r.number}`,
      author: { login: "alice" },
      isDraft: false,
      reviewDecision: "",
      updatedAt: r.updatedAt,
      url: `https://github.com/${repo}/pull/${r.number}`,
      headRefName: `branch-${r.number}`,
    })),
  );
}

export interface CommentRow {
  readonly id: string;
  readonly author?: string;
  readonly createdAt: string;
  readonly body?: string;
  readonly viewerDidAuthor?: boolean;
}

export function ownPrsJson(rows: readonly { number: number; title?: string; branch?: string; updatedAt: string; comments?: readonly CommentRow[] }[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      number: r.number,
      title: r.title ?? `Own PR ${r.number}`,
      author: { login: "me" },
      updatedAt: r.updatedAt,
      url: `https://github.com/${repo}/pull/${r.number}`,
      headRefName: r.branch ?? `own-${r.number}`,
      comments: (r.comments ?? []).map((c) => ({
        id: c.id,
        author: { login: c.author ?? "carol" },
        body: c.body ?? `Comment ${c.id}`,
        createdAt: c.createdAt,
        url: `https://github.com/${repo}/pull/${r.number}#issuecomment-${c.id}`,
        viewerDidAuthor: c.viewerDidAuthor ?? false,
      })),
    })),
  );
}

export function runsJson(rows: readonly { id: number; title?: string; branch: string; createdAt: string }[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      databaseId: r.id,
      displayTitle: r.title ?? `run ${r.id}`,
      status: "completed",
      conclusion: "failure",
      headBranch: r.branch,
      event: "push",
      createdAt: r.createdAt,
      url: `https://github.com/${repo}/actions/runs/${r.id}`,
    })),
  );
}

export type GhKind = "issue" | "review" | "pr" | "ci";

export function kindOfArgv(argv: readonly string[]): GhKind {
  if (argv[0] === "run") return "ci";
  if (argv[0] === "issue") return "issue";
  return argv.includes("--search") ? "review" : "pr";
}

export interface FakeGhCall {
  readonly kind: GhKind;
  readonly repo: string;
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly bin: string;
  readonly cwd: string;
}

/** A `GhRunner` that answers from fixtures per (kind, repo) and records every call. An unset source answers `[]`. */
export class FakeGh {
  readonly calls: FakeGhCall[] = [];
  private readonly answers = new Map<string, string>();
  private readonly failures = new Map<string, string>();
  onCall: ((call: FakeGhCall) => Promise<void> | void) | undefined;

  set(kind: GhKind, stdout: string, repo = REPO): this {
    this.answers.set(`${kind}:${repo}`, stdout);
    this.failures.delete(`${kind}:${repo}`);
    return this;
  }

  fail(kind: GhKind, detail: string, repo = REPO): this {
    this.failures.set(`${kind}:${repo}`, detail);
    return this;
  }

  restore(kind: GhKind, repo = REPO): this {
    this.failures.delete(`${kind}:${repo}`);
    return this;
  }

  readonly run: GhRunner = async (call: GhCall): Promise<GhResult> => {
    const repoAt = call.argv.indexOf("--repo");
    const repo = repoAt === -1 ? "" : (call.argv[repoAt + 1] ?? "");
    const kind = kindOfArgv(call.argv);
    const record: FakeGhCall = { kind, repo, argv: call.argv, env: call.env, bin: call.bin, cwd: call.cwd };
    this.calls.push(record);
    if (this.onCall !== undefined) await this.onCall(record);
    const key = `${kind}:${repo}`;
    const failure = this.failures.get(key);
    if (failure !== undefined) return { ok: false, stdout: "", detail: failure, exitCode: 1 };
    return { ok: true, stdout: this.answers.get(key) ?? "[]", detail: "", exitCode: 0 };
  };
}

// ---- Telegram ----------------------------------------------------------------------

/** A fake of serve's Bot API path: records the cards and the status lines it was asked to send. */
export class FakeSink implements IntakeCardSink {
  readonly cards: IntakeCardView[] = [];
  readonly statuses: string[] = [];
  /** One entry is consumed per card send attempt; an empty list means every send succeeds. */
  script: IntakeSendResult[] = [];
  statusOk = true;
  /** Every edit of a card already in Telegram, with the status line it was given (none keeps the buttons). */
  readonly edits: { readonly card: IntakeCardView; readonly status?: string }[] = [];
  editOk = true;
  /** Runs while a send is in flight, after the card was read and before the sink answers. */
  onSend: ((card: IntakeCardView) => Promise<void> | void) | undefined;
  private n = 0;

  async sendCard(card: IntakeCardView): Promise<IntakeSendResult> {
    if (this.onSend !== undefined) await this.onSend(card);
    const next = this.script.shift() ?? { ok: true as const, chatId: "-100", messageId: String(++this.n) };
    if (next.ok) this.cards.push(card);
    return next;
  }

  async editCard(card: IntakeCardView, status?: string): Promise<{ ok: boolean }> {
    if (this.editOk) this.edits.push({ card, ...(status !== undefined ? { status } : {}) });
    return { ok: this.editOk };
  }

  async sendStatus(text: string): Promise<{ ok: boolean }> {
    if (this.statusOk) this.statuses.push(text);
    return { ok: this.statusOk };
  }
}

/** A scripted model: every call costs `costUsd` and answers with a fixed assessment. It never reaches a network. */
export function fakeAssessor(options: { costUsd?: number; suggestion?: string; fail?: string } = {}): { assess: (input: IntakeAssessInput) => Promise<IntakeAssessResult>; inputs: IntakeAssessInput[] } {
  const inputs: IntakeAssessInput[] = [];
  return {
    inputs,
    assess: async (input) => {
      inputs.push(input);
      if (options.fail !== undefined) return { ok: false, reason: options.fail, costUsd: options.costUsd ?? 0 };
      return { ok: true, assessment: `assessment of ${input.event.key}`, ...(options.suggestion !== undefined ? { suggestion: options.suggestion } : {}), costUsd: options.costUsd ?? 0.01 };
    },
  };
}

export function depsFor(env: IntakeTestEnv, parts: { gh: FakeGh; clock: TestClock; sink?: FakeSink; assess?: IntakeDeps["assess"]; config?: IntakeConfig; manual?: boolean }): IntakeDeps {
  return {
    now: parts.clock.now,
    env: env.env,
    runGh: parts.gh.run,
    ...(parts.sink !== undefined ? { sink: parts.sink } : {}),
    ...(parts.assess !== undefined ? { assess: parts.assess } : {}),
    ...(parts.config !== undefined ? { config: parts.config } : {}),
    ...(parts.manual === true ? { manual: true } : {}),
  };
}

export const testConfig = (patch: Partial<IntakeConfig> = {}): IntakeConfig => ({ ...DEFAULT_INTAKE_CONFIG, enabled: true, repos: [REPO], ...patch });

/** The first poll of a project only takes a baseline; this runs it and moves the clock past the poll interval. */
export async function takeBaseline(root: string, deps: IntakeDeps, clock: TestClock): Promise<IntakePollResult> {
  const result = await runIntakePoll(root, deps);
  clock.advance(11 * 60_000);
  return result;
}

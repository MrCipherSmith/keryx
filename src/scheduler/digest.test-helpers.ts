// Flow 389: shared test support for the scheduled digest.
//
// Everything a digest test needs to run with NO live anything (AC10):
//   - a throwaway project root laid out from the product fixture corpus (a real board),
//     with HOME and XDG_DATA_HOME pointed away from the developer's, so confirming a
//     schedule never writes the real signing key;
//   - a fake `gh` (a `GhRunner` that answers per argv from fixtures and records every call),
//     plus a harmless stub `gh` file on disk that is pinned the way `draftSchedule` pins it;
//   - a fake delivery sink, and a scripted summariser;
//   - a clock the test moves by hand.

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTriggerOnce } from "../commands/trigger";
import { pinGrantedBinary, type BinaryPin } from "../trigger/granted-binary";
import { DIGEST_TOOL_IDS } from "../trigger/granted-tools";
import { addConfirmedSchedule } from "../trigger/store";
import { copyBoardProject } from "./digest-board-project.test";
import type { DigestSink, SinkResult } from "./digest-delivery";
import type { GhCall, GhResult, GhRunner } from "./digest-gh";
import type { DigestDeps } from "./digest-run";
import type { DigestSummarizer } from "./digest-summary";

export const REPO = "MrCipherSmith/keryx";
export const OTHER_REPO = "MrCipherSmith/other";

/** A fixed "now" for the runs; the tests move it with `clock.set`. */
export class TestClock {
  private ms: number;
  constructor(start: string) {
    this.ms = Date.parse(start);
  }
  now = (): Date => new Date(this.ms);
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface DigestTestEnv {
  /** The project root: a git repo holding the fixture flow board and its product index. */
  readonly root: string;
  /** Outside the project: holds the stub `gh`. */
  readonly aside: string;
  readonly ghBin: string;
  /** Everything printed to the console, in order. */
  readonly logged: string[];
  teardown(): Promise<void>;
}

export async function setupDigestEnv(options: { board?: boolean } = {}): Promise<DigestTestEnv> {
  const saved = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };
  const keyHome = await mkdtemp(path.join(tmpdir(), "keryx-digest-home-"));
  process.env["HOME"] = keyHome;
  process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
  const root = await copyBoardProject({ board: options.board !== false });
  const aside = await mkdtemp(path.join(tmpdir(), "keryx-digest-aside-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const ghBin = path.join(aside, "gh");
  await writeFile(ghBin, "#!/bin/sh\necho '[]'\n", "utf8");
  await chmod(ghBin, 0o755);
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
  return {
    root,
    aside,
    ghBin,
    logged,
    teardown: async () => {
      console.log = realLog;
      console.error = realError;
      process.exitCode = 0;
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
      await rm(aside, { recursive: true, force: true });
      await rm(keyHome, { recursive: true, force: true });
    },
  };
}

export interface DigestScheduleOptions {
  readonly name?: string;
  readonly cron?: string;
  readonly repos?: readonly string[];
  readonly tools?: readonly string[];
  readonly topic?: string;
  readonly memoryLimitMb?: number;
  readonly ceilingUsd?: number;
  readonly maxSeconds?: number;
}

function pinOf(env: DigestTestEnv): Record<string, BinaryPin> {
  const pinned = pinGrantedBinary("gh", env.ghBin, "/nonexistent-project-root");
  if (!pinned.ok) throw new Error(pinned.reason);
  return { gh: pinned.pin };
}

/** The entry `keryx schedule add --digest` drafts: what a test hands to `addConfirmedSchedule`, or to `confirmSchedule` inside a draft. */
export function digestScheduleEntry(env: DigestTestEnv, options: DigestScheduleOptions = {}): Record<string, unknown> {
  const name = options.name ?? "morning";
  return {
    name,
    on: { kind: "schedule", cron: options.cron ?? "* * * * *" },
    // The runner `draftSchedule` records. A digest never installs it (serve fires the schedule), but resume checks it is there.
    install: { argv: ["/usr/local/bin/keryx"], env: {} },
    action: {
      kind: "agent-task",
      prompt: "Scheduled GitHub and board digest",
      dispatch: {
        provider: "scripted",
        model: "m",
        permissionMode: "ask",
        rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
        ceilingUsd: options.ceilingUsd ?? 0.2,
        maxSeconds: options.maxSeconds ?? 600,
      },
      grants: {
        network: "off",
        tools: [...(options.tools ?? DIGEST_TOOL_IDS)],
        repos: [...(options.repos ?? [REPO])],
        bins: { gh: env.ghBin },
        binDigests: pinOf(env),
      },
      digest: { topic: options.topic ?? "Digest", memoryLimitMb: options.memoryLimitMb ?? 512 },
    },
  };
}

/** Store a confirmed digest schedule exactly as `keryx schedule add --digest` would. Returns its name. */
export async function addDigestSchedule(env: DigestTestEnv, options: DigestScheduleOptions = {}): Promise<string> {
  await addConfirmedSchedule(env.root, digestScheduleEntry(env, options));
  return options.name ?? "morning";
}

// ---- gh fixtures --------------------------------------------------------------

export interface PrRow {
  readonly number: number;
  readonly title?: string;
  readonly author?: string;
  readonly updatedAt: string;
  readonly isDraft?: boolean;
  readonly reviewDecision?: string;
}

export function prJson(rows: readonly PrRow[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      number: r.number,
      title: r.title ?? `PR ${r.number}`,
      author: { login: r.author ?? "alice" },
      isDraft: r.isDraft ?? false,
      reviewDecision: r.reviewDecision ?? "",
      updatedAt: r.updatedAt,
      url: `https://github.com/${repo}/pull/${r.number}`,
      headRefName: `branch-${r.number}`,
    })),
  );
}

export function issueJson(rows: readonly { number: number; title?: string; updatedAt: string; author?: string }[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      number: r.number,
      title: r.title ?? `Issue ${r.number}`,
      author: { login: r.author ?? "bob" },
      labels: [],
      updatedAt: r.updatedAt,
      url: `https://github.com/${repo}/issues/${r.number}`,
    })),
  );
}

export function ciJson(rows: readonly { id: number; title?: string; branch?: string; createdAt: string }[], repo = REPO): string {
  return JSON.stringify(
    rows.map((r) => ({
      databaseId: r.id,
      displayTitle: r.title ?? `run ${r.id}`,
      status: "completed",
      conclusion: "failure",
      headBranch: r.branch ?? "main",
      event: "push",
      createdAt: r.createdAt,
      url: `https://github.com/${repo}/actions/runs/${r.id}`,
    })),
  );
}

export type GhKind = "pr" | "issue" | "review" | "ci";

export interface FakeGhCall {
  readonly kind: GhKind;
  readonly repo: string;
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly bin: string;
  readonly cwd: string;
}

export function kindOfArgv(argv: readonly string[]): GhKind {
  if (argv[0] === "run") return "ci";
  if (argv[0] === "issue") return "issue";
  return argv.includes("--search") ? "review" : "pr";
}

/** A `GhRunner` that answers from fixtures per (kind, repo) and records every call it was given. */
export class FakeGh {
  readonly calls: FakeGhCall[] = [];
  private readonly answers = new Map<string, string>();
  private readonly failures = new Map<string, string>();
  /** Runs before each answer; a test uses it to move the clock, hang, or allocate. */
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

  /** Every kind answers an empty list, until `set` says otherwise. */
  empty(repo = REPO): this {
    for (const kind of ["pr", "issue", "review", "ci"] as const) {
      if (!this.answers.has(`${kind}:${repo}`)) this.answers.set(`${kind}:${repo}`, "[]");
    }
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
    const stdout = this.answers.get(key);
    if (stdout === undefined) return { ok: false, stdout: "", detail: `fake gh has no answer for ${key}`, exitCode: 1 };
    return { ok: true, stdout, detail: "", exitCode: 0 };
  };
}

// ---- delivery -----------------------------------------------------------------

export interface SentMessage {
  readonly via: "session" | "topic";
  /** The session id, or the topic name. */
  readonly to: string;
  readonly text: string;
}

/** A fake of serve's Telegram path. A test scripts what it answers and reads what it was asked to send. */
export class FakeSink implements DigestSink {
  readonly sent: SentMessage[] = [];
  session: string | undefined;
  /** One entry is consumed per send attempt; an empty list means every send succeeds. */
  script: SinkResult[] = [];

  sessionFor(): string | undefined {
    return this.session;
  }
  sendToSession(sessionId: string, text: string): Promise<SinkResult> {
    return Promise.resolve(this.take({ via: "session", to: sessionId, text }));
  }
  sendToTopic(topic: string, text: string): Promise<SinkResult> {
    return Promise.resolve(this.take({ via: "topic", to: topic, text }));
  }
  private take(message: SentMessage): SinkResult {
    const next = this.script.shift() ?? { ok: true, state: "sent" };
    if (next.ok) this.sent.push(message);
    return next;
  }
}

/** A summariser that never reaches a model. */
export function fakeSummary(text = "Two things need you first."): { summarize: DigestSummarizer; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    summarize: async () => {
      calls += 1;
      return { ok: true, text, cost: { recorded: true, usd: 0.01 } };
    },
  };
}

export function failingSummary(reason: string): DigestSummarizer {
  return async () => ({ ok: false, reason, cost: { recorded: false, reason: "no model was called" } });
}

/** Run one digest the way `keryx serve` does: through `runTriggerOnce`, schedule-only, with the fakes in `deps`. */
export async function runDigest(env: DigestTestEnv, name: string, deps: DigestDeps): Promise<void> {
  await runTriggerOnce(env.root, name, { digest: deps }, { scheduleOnly: true });
}

// A configurable fake agent, and a fixture repository to run it against.
//
// The pilot declares a fake inline in each test file — `fakeAgent` in
// `retrieval-run.test.ts:49`, `okAgent`/`counting`/`flaky` in
// `retrieval-sweep.test.ts`. That was fine while the only thing under test was
// "did both arms get different trees". The arena adds a watchdog, and a watchdog
// cannot be tested by an agent that always answers promptly: it needs one that
// goes quiet, one that loops, and — the case usually forgotten — one that works
// honestly right up to the edge of its budget and must NOT be killed.
//
// So the fake grows knobs, and they live here rather than in a test file, because
// three test files need the same ones.
//
// Everything in this module is for tests. No model is called, nothing is spent,
// and that is deliberate: a harness whose wiring can only be exercised by paying
// for model calls does not get exercised.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentAnswer, AgentPort } from "../benchmark/retrieval-run";
import type { RetrievalTask } from "../benchmark/retrieval-tasks";

export interface FakeAgentOptions {
  /** The harness id this fake records. Two fakes with different ids must not collide. */
  readonly harnessId: string;
  /** What the agent "answers". For a retrieval task, paths in prose. */
  readonly answer?: string;
  readonly toolCalls?: number;
  readonly contextTokens?: number | null;
  readonly costUsd?: number | null;
  readonly stepsToFirstGold?: number | null;
  /** Resolve only after this long. Used to test the hard ceiling and the honest-long-run case. */
  readonly runsForMs?: number;
  /** Emit nothing for this long before finishing. Used to test silence detection. */
  readonly silentForMs?: number;
  /** Repeat one identical tool call this many times. Used to test loop detection. */
  readonly loopSameCall?: number;
  /** Throw after this long, to stand in for a crashed CLI. */
  readonly throwAfterMs?: number;
  /** Called on every simulated tool call, so a watchdog under test can observe progress. */
  readonly onActivity?: (event: { readonly name: string; readonly input: string }) => void;
}

export interface FakeAgentRecord {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly gold: readonly string[];
}

export interface FakeAgent extends AgentPort {
  /** Every call this fake received, in order. The assertion surface for arm wiring. */
  readonly seen: readonly FakeAgentRecord[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An agent that does what it is told and records what it saw.
 *
 * `seen` is the assertion surface for the wiring tests: that both arms ran, that
 * they ran in different trees, and that the prompt was byte-identical between
 * them — which is the one thing a benchmark comparing two arms must never get
 * wrong, and which no amount of real-model spending would prove more clearly.
 */
export function createFakeAgent(options: FakeAgentOptions): FakeAgent {
  const seen: FakeAgentRecord[] = [];
  return {
    harness: options.harnessId,
    seen,
    async run({ cwd, prompt, model, gold }): Promise<AgentAnswer> {
      seen.push({ cwd, prompt, model, gold });

      for (let i = 0; i < (options.loopSameCall ?? 0); i += 1) {
        options.onActivity?.({ name: "search_code", input: '{"pattern":"the same thing again"}' });
      }

      if (options.throwAfterMs !== undefined) {
        await sleep(options.throwAfterMs);
        throw new Error(`${options.harnessId}: the fake was told to die`);
      }
      if (options.silentForMs !== undefined) await sleep(options.silentForMs);
      if (options.runsForMs !== undefined) await sleep(options.runsForMs);

      return {
        text: options.answer ?? "src/charge.ts",
        toolCalls: options.toolCalls ?? 3,
        contextTokens: options.contextTokens === undefined ? 1000 : options.contextTokens,
        costUsd: options.costUsd === undefined ? 0.01 : options.costUsd,
        stepsToFirstGold: options.stepsToFirstGold === undefined ? 2 : options.stepsToFirstGold,
      };
    },
  };
}

export interface ArenaFixture {
  readonly root: string;
  readonly task: RetrievalTask;
}

/**
 * A real two-commit git repository, shaped like the arena's target.
 *
 * Real rather than mocked because `createIsolatedCheckout` runs actual git —
 * `init`, `remote add`, a shallow `fetch`, `checkout`, `remote remove` — and a
 * mock of git proves nothing about whether a shallow fetch of the parent really
 * withholds the commit that holds the answer.
 *
 * Two differences from the pilot's fixture, both deliberate:
 *
 *  - `AGENTS.md` and `CLAUDE.md` are present and must SURVIVE in both arms. They
 *    are vantage-frontend's own instruction layer, identical on both sides, and
 *    the arena ablates only `.metaproject/`. The pilot's `stripContext` deletes
 *    all three, which would make every arena control arm fail `assertArmContext`.
 *  - there is a `src/pipelines` directory, because the real repository's source
 *    layout is what `retrieval-languages.ts` classification and the graph see.
 */
export async function arenaFixtureRepo(): Promise<ArenaFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-arena-fixture-"));
  const git = (args: string[]): string => {
    const proc = Bun.spawnSync(["git", "-C", root, ...args]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  };

  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "fixture"]);

  await mkdir(path.join(root, "src", "pipelines"), { recursive: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, "src", "pipelines", "iterator-dnd.ts"), "export const rate = 1;\n", "utf8");
  await writeFile(path.join(root, ".metaproject", "index.md"), "# routing index\n", "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), "# project rules, present in BOTH arms\n", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), "# project rules, present in BOTH arms\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "before"]);
  const parent = git(["rev-parse", "HEAD"]);

  // The change itself. Its content must never reach the agent.
  await writeFile(path.join(root, "src", "pipelines", "iterator-dnd.ts"), "export const rate = 2;\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fix(pipelines): a step cannot leave its iterator (#1)"]);
  const sha = git(["rev-parse", "HEAD"]);

  return {
    root,
    task: {
      id: sha.slice(0, 8),
      sha,
      parent,
      query: "a step cannot leave its iterator",
      gold: ["src/pipelines/iterator-dnd.ts"],
    },
  };
}

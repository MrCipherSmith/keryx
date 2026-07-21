#!/usr/bin/env bun
/**
 * keryx shell — stress / boundary harness.
 *
 * Drives the REAL interactive-agent stack (`runAgentTurn` + the real builtin
 * tools + the real approval/risk gate + the real MAE spawn path) with a scripted
 * `ProviderPort`, so every assertion exercises production code paths without a
 * live LLM and without non-determinism.
 *
 * Suites: P (permission/approval), C (injection/escaping), T (concurrency),
 * M (multi-agent), S (sandbox isolation), L (longevity/leaks).
 *
 * Safety rules baked in:
 *   - Destructive commands (P2) are NEVER handed to the runner. Only the gate
 *     that would block them is exercised (default-deny + pattern matching).
 *   - Egress probes (S3) are loopback-only unless `--allow-egress` is passed.
 *   - Every fixture lives in a throwaway temp root and is removed at the end.
 *
 * Usage:
 *   bun scripts/stress/keryx-shell-stress.ts [--only P1,T3] [--skip T2]
 *        [--big-file-mb 256] [--allow-egress] [--out <dir>]
 */

import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runAgentTurn,
  DEFAULT_MAX_TOOL_CALLS,
  MAX_ATTEMPTS_PER_HASH,
  resolveAgentMaxToolCalls,
} from "../../src/commands/agent";
import type { AgentDeps, AgentIO } from "../../src/commands/agent";
import {
  builtinReadOnlyTools,
  type InteractiveTool,
} from "../../src/harness/tool/builtin/interactive-tools";
import {
  shellExecTool,
  makeCommandRunner,
  resolveShellSandboxMode,
} from "../../src/harness/tool/builtin/shell-exec-tool";
import {
  builtinMetaprojectTools,
  makeKeryxRunner,
} from "../../src/harness/tool/builtin/metaproject-tools";
import { createSpawnSubagentTool } from "../../src/harness/tool/builtin/spawn-subagent-tool";
import {
  isShellCommandAllowed,
  matchShellPattern,
  suggestShellPatterns,
  loadShellPermissions,
} from "../../src/lib/shell-permissions";
import { detectSandboxLauncher } from "../../src/harness/process/sandbox/detect";
import { DEFAULT_MAX_CHILDREN } from "../../src/harness/child/orchestrate";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
} from "../../src/harness/provider/types";

// ---------------------------------------------------------------- CLI / state

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const ONLY = (opt("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SKIP = (opt("skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const BIG_MB = Number.parseInt(opt("big-file-mb", "256") ?? "256", 10);
const T1_MB = Number.parseInt(opt("t1-file-mb", "16") ?? "16", 10);
const ALLOW_EGRESS = flag("allow-egress");
const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const OUT_DIR = opt("out") ?? path.join(REPO_ROOT, ".metaproject", "data", "stress");

type Verdict = "PASS" | "FAIL" | "RISK" | "INFO" | "SKIP";

interface Finding {
  id: string;
  area: string;
  what: string;
  expected: string;
  observed: string;
  verdict: Verdict;
  ms: number;
  rssDeltaMb?: number;
  detail?: Record<string, unknown>;
}

const findings: Finding[] = [];

function rssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function record(f: Omit<Finding, "ms"> & { ms?: number }): void {
  const done: Finding = { ms: 0, ...f };
  findings.push(done);
  const icon =
    done.verdict === "PASS" ? "✓" : done.verdict === "FAIL" ? "✗" : done.verdict === "RISK" ? "!" : "·";
  console.log(
    `${icon} ${done.id.padEnd(4)} ${done.verdict.padEnd(4)} ${String(Math.round(done.ms)).padStart(6)}ms  ${done.observed}`,
  );
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number; rssDeltaMb: number }> {
  const t0 = performance.now();
  const r0 = rssMb();
  const value = await fn();
  return { value, ms: performance.now() - t0, rssDeltaMb: rssMb() - r0 };
}

function selected(id: string): boolean {
  if (SKIP.includes(id)) return false;
  return ONLY.length === 0 || ONLY.includes(id) || ONLY.includes(id[0] ?? "");
}

// ------------------------------------------------------- scripted provider IO

const CAPS: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: true,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

/** Replay a fixed list of event-rounds; extra rounds finish with plain text. */
function scriptedProvider(rounds: Partial<NormalizedEvent>[][], tailText = "done."): {
  provider: ProviderPort;
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  return {
    requests,
    provider: {
      describe: () => CAPS,
      stream: (request, opts) => {
        requests.push(request);
        const events =
          rounds[call] ?? [{ kind: "text_delta", text: tailText }, { kind: "model_end" }];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield {
              sequence: sequence++,
              attemptId: opts.attemptId,
              kind: "model_end",
              ...partial,
            } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

/** A provider whose stream never yields and never returns (hang simulation). */
function hangingProvider(): ProviderPort {
  return {
    describe: () => CAPS,
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {
          /* never resolves */
        });
      })(),
  };
}

/** One round of N tool calls (the "parallel tool calls" shape a model emits). */
function callRound(calls: { name: string; input: unknown; id?: string }[]): Partial<NormalizedEvent>[] {
  const events: Partial<NormalizedEvent>[] = [];
  calls.forEach((c, i) => {
    const id = c.id ?? `c${i}`;
    events.push({ kind: "tool_call_start", toolCallId: id, toolName: c.name });
    events.push({ kind: "tool_call_end", toolCallId: id, input: JSON.stringify(c.input) });
  });
  events.push({ kind: "model_end" });
  return events;
}

interface TurnLog {
  toolCalls: string[];
  results: { name: string; isError: boolean; output: string }[];
  approvals: { tool: string; input: string; granted: boolean }[];
  system: string[];
}

/** Run one real agent turn against real tools with a scripted model. */
async function runTurn(
  tools: InteractiveTool[],
  rounds: Partial<NormalizedEvent>[][],
  approver?: (tool: string, input: string) => Promise<boolean>,
  overrides: Partial<AgentDeps> = {},
): Promise<TurnLog> {
  const { provider } = scriptedProvider(rounds);
  const log: TurnLog = { toolCalls: [], results: [], approvals: [], system: [] };
  let n = 0;
  const io: AgentIO = {
    write: () => {},
    onToolCall: (name) => log.toolCalls.push(name),
    onToolResult: (name, r) => log.results.push({ name, isError: r.isError, output: r.output }),
    onSystem: (t) => log.system.push(t),
    ...(approver !== undefined
      ? {
          requestApproval: async (tool: string, input: string) => {
            const granted = await approver(tool, input);
            log.approvals.push({ tool, input, granted });
            return granted;
          },
        }
      : {}),
  };
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "scripted-model",
    tools,
    systemInstruction: "stress harness",
    idSeq: () => `id-${n++}`,
    ...overrides,
  };
  await runAgentTurn(io, deps, [], "stress");
  return log;
}

// ----------------------------------------------------------------- fixtures

const FIX_ROOT = mkdtempSync(path.join(tmpdir(), "keryx-stress-"));
let bigFile = "";
let t1File = "";

function makeFixtures(): void {
  writeFileSync(path.join(FIX_ROOT, "hello.txt"), "hello from the fixture root\n");
  writeFileSync(path.join(FIX_ROOT, "notes.md"), "# notes\nline\n".repeat(200));
}

function makeBigFile(name: string, mb: number): string {
  const p = path.join(FIX_ROOT, name);
  if (existsSync(p) && statSync(p).size >= mb * 1024 * 1024) return p;
  const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a'
  const fh = Bun.file(p).writer();
  for (let i = 0; i < mb; i++) fh.write(chunk);
  fh.end();
  return p;
}

// ------------------------------------------------------------ shared factories

const shellTools = (root: string): InteractiveTool[] => [
  ...builtinReadOnlyTools(root),
  shellExecTool(root),
];

/** spawn_subagent bound to a scripted child provider. */
function spawnToolWith(childRounds: Partial<NormalizedEvent>[][], hang = false): InteractiveTool {
  return createSpawnSubagentTool({
    cwd: FIX_ROOT,
    getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
    makeProvider: () => (hang ? hangingProvider() : scriptedProvider(childRounds, "child summary ok").provider),
    getDetectedProviders: () => [{ name: "anthropic" }],
  });
}

// ============================================================ 2.1 PERMISSION

async function P1(): Promise<void> {
  // 10 identical shell_exec("echo 1") in ONE model round (parallel tool calls).
  const approvals: string[] = [];
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound(Array.from({ length: 10 }, (_, i) => ({ name: "shell_exec", input: { command: "echo 1" }, id: `p1-${i}` })))],
      async (_tool, input) => {
        approvals.push(input);
        return true;
      },
    ),
  );
  const log = t.value;
  const executed = log.results.filter((r) => r.output.trim() === "1").length;
  const budgetBlocked = log.results.filter((r) => r.output.includes("already tried")).length;
  record({
    id: "P1",
    area: "permission",
    what: '10× shell_exec("echo 1") in one round',
    expected: "N pending approvals, nothing lost, no crash",
    verdict: approvals.length === MAX_ATTEMPTS_PER_HASH ? "RISK" : "INFO",
    observed:
      `approvals=${approvals.length} executed=${executed} hash-blocked=${budgetBlocked} ` +
      `(identical calls collapse to ONE budget slot, max ${MAX_ATTEMPTS_PER_HASH} attempts)`,
    ms: t.ms,
    detail: { approvals: approvals.length, executed, budgetBlocked, toolCalls: log.toolCalls.length },
  });

  // Variant: 10 DISTINCT commands → 10 approvals, all sequential.
  const order: number[] = [];
  const t2 = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [
        callRound(
          Array.from({ length: 10 }, (_, i) => ({
            name: "shell_exec",
            input: { command: `echo ${i}` },
            id: `p1b-${i}`,
          })),
        ),
      ],
      async (_t, input) => {
        order.push(order.length);
        // Simulate a slow human: proves the gate serializes.
        await new Promise((r) => setTimeout(r, 5));
        return true;
      },
    ),
  );
  const ok = t2.value.results.filter((r) => !r.isError).length;
  record({
    id: "P1b",
    area: "permission",
    what: "10× DISTINCT shell_exec in one round",
    expected: "10 approvals, no approval lost",
    verdict: ok === 10 && order.length === 10 ? "PASS" : "FAIL",
    observed: `approvals=${order.length} executed-ok=${ok} (strictly sequential, one at a time)`,
    ms: t2.ms,
    detail: { approvals: order.length, ok },
  });
}

async function P2(): Promise<void> {
  const DANGER = "rm -rf /";
  const t = await timed(async () => {
    // (a) default-deny: no approver at all → never executes.
    const noApprover = await runTurn(shellTools(FIX_ROOT), [
      callRound([{ name: "shell_exec", input: { command: DANGER } }]),
    ]);
    // (b) approver denies.
    const denied = await runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: DANGER } }])],
      async () => false,
    );
    // (c) is there ANY deny-list / policy that would block it before the human?
    const userAllow = loadShellPermissions().allow;
    const autoAllowed = isShellCommandAllowed(DANGER, userAllow);
    // (d) would a plausible remembered prefix match it?
    const prefixFromBenign = suggestShellPatterns("rm -rf ./dist").prefix; // "rm *"
    const overreach = matchShellPattern(prefixFromBenign, DANGER);
    return { noApprover, denied, autoAllowed, prefixFromBenign, overreach, userAllow };
  });
  const v = t.value;
  const blockedA = v.noApprover.results.every((r) => r.isError && r.output.includes("not approved"));
  const blockedB = v.denied.results.every((r) => r.isError && r.output.includes("not approved"));
  record({
    id: "P2",
    area: "permission",
    what: 'shell_exec("rm -rf /") — gate only, never executed',
    expected: "blocked by sandbox or user policy",
    verdict: blockedA && blockedB && !v.autoAllowed ? "PASS" : "FAIL",
    observed:
      `default-deny=${blockedA} explicit-deny=${blockedB} auto-allowed-by-saved-patterns=${v.autoAllowed}; ` +
      `NO command deny-list exists — the human approval gate is the only barrier`,
    ms: t.ms,
    detail: { savedPatterns: v.userAllow },
  });
  record({
    id: "P2b",
    area: "permission",
    what: '"always allow prefix" grant from a benign rm',
    expected: "a remembered prefix should not cover destructive variants",
    verdict: v.overreach ? "RISK" : "PASS",
    observed:
      `suggestShellPatterns("rm -rf ./dist").prefix = "${v.prefixFromBenign}" and it matches "${DANGER}" → ${v.overreach}`,
    ms: 0,
    detail: { prefix: v.prefixFromBenign, matches: v.overreach },
  });
}

async function P3(): Promise<void> {
  // `sudo -n` (non-interactive) so the harness can never block on a TTY password.
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: "sudo -n whoami" } }])],
      async () => true,
    ),
  );
  const r = t.value.results[0];
  record({
    id: "P3",
    area: "permission",
    what: 'shell_exec("sudo -n whoami")',
    expected: "non-zero exit handled, no crash",
    verdict: r !== undefined ? "PASS" : "FAIL",
    observed: `isError=${r?.isError} output=${JSON.stringify((r?.output ?? "").slice(0, 120))}`,
    ms: t.ms,
  });
}

async function P4(): Promise<void> {
  const targets =
    process.platform === "darwin"
      ? ["cat /etc/shadow", "cat /etc/master.passwd"]
      : ["cat /etc/shadow"];
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound(targets.map((c, i) => ({ name: "shell_exec", input: { command: c }, id: `p4-${i}` })))],
      async () => true,
    ),
  );
  const rows = t.value.results.map((r) => `${r.isError ? "err" : "OK"}:${r.output.split("\n")[0]?.slice(0, 60)}`);
  const leaked = t.value.results.some((r) => !r.isError && r.output.length > 40);
  record({
    id: "P4",
    area: "permission",
    what: "cat /etc/shadow (+ /etc/master.passwd on darwin)",
    expected: "error result, no crash, no content",
    verdict: leaked ? "FAIL" : "PASS",
    observed: rows.join(" | "),
    ms: t.ms,
  });
}

// ============================================================ 2.2 INJECTION

async function C1(): Promise<void> {
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: "echo hello; whoami" } }])],
      async () => true,
    ),
  );
  const out = t.value.results[0]?.output ?? "";
  const bothRan = out.includes("hello") && out.trim().split("\n").length > 1;
  record({
    id: "C1",
    area: "injection",
    what: 'shell_exec("echo hello; whoami")',
    expected: "runs as one command (sandbox-level shell safety)",
    verdict: bothRan ? "RISK" : "PASS",
    observed: `full /bin/sh -c semantics: ${bothRan ? "BOTH commands ran" : "single command"} → ${JSON.stringify(out.slice(0, 80))}`,
    ms: t.ms,
  });
}

async function C2(): Promise<void> {
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [
        callRound([
          { name: "shell_exec", input: { command: "echo '$(id)'" }, id: "c2a" },
          { name: "shell_exec", input: { command: 'echo "$(id -u)"' }, id: "c2b" },
        ]),
      ],
      async () => true,
    ),
  );
  const [single, double] = t.value.results;
  record({
    id: "C2",
    area: "injection",
    what: "single- vs double-quoted command substitution",
    expected: "substitution runs or is escaped — sandbox dependent",
    verdict: "INFO",
    observed: `single-quoted → ${JSON.stringify(single?.output.slice(0, 40))}; double-quoted → ${JSON.stringify(double?.output.slice(0, 40))} (no keryx-side escaping layer; shell semantics are verbatim)`,
    ms: t.ms,
  });
}

async function C3(): Promise<void> {
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: "ping -c 1 127.0.0.1" } }])],
      async () => true,
    ),
  );
  record({
    id: "C3",
    area: "injection",
    what: 'shell_exec("ping -c 1 127.0.0.1")',
    expected: "timeout / block / must not hang the agent",
    verdict: "INFO",
    observed: `isError=${t.value.results[0]?.isError} in ${Math.round(t.ms)}ms (loopback ping is not filtered)`,
    ms: t.ms,
  });

  // The real question C3 is asking: is there ANY timeout on shell_exec?
  const SLEEP_S = 6;
  const t2 = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: `sleep ${SLEEP_S}` } }])],
      async () => true,
    ),
  );
  const noTimeout = t2.ms >= SLEEP_S * 1000 * 0.9;
  record({
    id: "C3b",
    area: "injection",
    what: `shell_exec("sleep ${SLEEP_S}") — timeout probe`,
    expected: "some deadline kills a long command",
    verdict: noTimeout ? "RISK" : "PASS",
    observed: noTimeout
      ? `ran the FULL ${SLEEP_S}s (${Math.round(t2.ms)}ms) — shell_exec has NO timeout and NO cancellation; a hanging command hangs the turn forever`
      : `terminated early at ${Math.round(t2.ms)}ms`,
    ms: t2.ms,
  });
}

// ============================================================ 2.3 CONCURRENCY

async function T1(): Promise<void> {
  t1File = makeBigFile("t1-big.bin", T1_MB);
  const tools = builtinReadOnlyTools(FIX_ROOT);
  const readTool = tools.find((x) => x.definition.name === "read_file")!;
  const before = rssMb();
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, rssMb());
  }, 20);
  const t = await timed(async () =>
    Promise.all(
      Array.from({ length: 20 }, () => readTool.invoke({ path: path.basename(t1File) })),
    ),
  );
  clearInterval(sampler);
  const outLen = t.value[0]?.output.length ?? 0;
  const growth = peak - before;
  record({
    id: "T1",
    area: "concurrency",
    what: `20× read_file on a ${T1_MB} MiB file, concurrently`,
    expected: "stay in budget, no OOM",
    verdict: growth > T1_MB ? "RISK" : "PASS",
    observed:
      `peak RSS +${growth.toFixed(0)} MiB for ${20 * T1_MB} MiB of requested reads; each result truncated to ${outLen} chars ` +
      `(readFile loads the WHOLE file before the 20 KB cap is applied — no streaming, no concurrency limit)`,
    ms: t.ms,
    rssDeltaMb: growth,
    detail: { fileMb: T1_MB, parallel: 20, outputChars: outLen },
  });
}

async function T2(): Promise<void> {
  // Real `keryx ctx rg` subprocesses. Path-scoped to `src` so the raw-log
  // artifacts stay bounded; the concurrency (10) is what is under test.
  const tools = builtinMetaprojectTools(REPO_ROOT, makeKeryxRunner(REPO_ROOT));
  const search = tools.find((x) => x.definition.name === "search_code")!;
  const t = await timed(async () =>
    Promise.all(Array.from({ length: 10 }, () => search.invoke({ pattern: ".", path: "src" }))),
  );
  const errs = t.value.filter((r) => r.isError).length;
  const maxLen = Math.max(...t.value.map((r) => r.output.length));
  record({
    id: "T2",
    area: "concurrency",
    what: '10× search_code(pattern=".", path="src") concurrently',
    expected: "ripgrep survives, ctx rg limits output",
    verdict: errs === 0 ? "PASS" : "RISK",
    observed: `10 concurrent keryx ctx rg in ${Math.round(t.ms)}ms, errors=${errs}, max result ${maxLen} chars (capped at 20 KB by the tool)`,
    ms: t.ms,
    detail: { errors: errs, maxLen },
  });
}

async function T3(): Promise<void> {
  const child = [callRound([{ name: "get_cwd", input: {} }])];
  const spawn = spawnToolWith(child);
  const t = await timed(async () =>
    Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        spawn.invoke({ task: `probe ${i}`, mode: "read_only", max_tool_calls: 50, label: `t3-${i}` }),
      ),
    ),
  );
  const denied = t.value.filter((r) => r.isError).length;
  const admitted = t.value.length - denied;
  const reason = t.value.find((r) => r.isError)?.output.slice(0, 140) ?? "—";
  record({
    id: "T3",
    area: "concurrency",
    what: "5× spawn_subagent concurrently, max_tool_calls=50 each",
    expected: "no deadlock, no stack overflow",
    verdict: admitted > 0 && denied > 0 ? "INFO" : admitted === 5 ? "PASS" : "RISK",
    observed:
      `admitted=${admitted} denied=${denied} in ${Math.round(t.ms)}ms; max_tool_calls clamped 50→16; ` +
      `first denial: ${JSON.stringify(reason)}`,
    ms: t.ms,
    detail: { admitted, denied, maxChildrenConst: DEFAULT_MAX_CHILDREN },
  });
}

async function T4(): Promise<void> {
  // A → B where B tries to spawn C.
  const childTriesToSpawn = [
    callRound([{ name: "spawn_subagent", input: { task: "grandchild" } }]),
  ];
  const spawn = spawnToolWith(childTriesToSpawn);
  const t = await timed(async () => spawn.invoke({ task: "depth probe", mode: "general", label: "t4" }));
  const out = t.value.output;
  const noTool = out.includes("unknown tool") || !out.includes("grandchild");
  record({
    id: "T4",
    area: "concurrency",
    what: "cycle A→B→C→D→A / max depth",
    expected: "cycle detection or a depth cap",
    verdict: noTool ? "PASS" : "FAIL",
    observed:
      `a child has NO spawn_subagent tool (child policy delegate=deny, maxTreeDepth=2) → a cycle is structurally impossible; ` +
      `child result: ${JSON.stringify(out.slice(0, 100))}`,
    ms: t.ms,
  });
}

// ============================================================ 2.4 MULTI-AGENT

async function M1(): Promise<void> {
  const child = [callRound([{ name: "read_file", input: { path: "hello.txt" } }])];
  const spawn = spawnToolWith(child);
  const t = await timed(async () =>
    Promise.all(
      Array.from({ length: 10 }, (_, i) => spawn.invoke({ task: `read hello ${i}`, label: `m1-${i}` })),
    ),
  );
  const denied = t.value.filter((r) => r.isError);
  const admitted = t.value.length - denied.length;
  record({
    id: "M1",
    area: "multi-agent",
    what: "10 subagents reading the same file",
    expected: "read parallelism, no race on shared MCP state",
    verdict: admitted < 10 ? "RISK" : "PASS",
    observed:
      `admitted=${admitted}/10, denied=${denied.length} — the per-shell RemainingBudgetLedger ` +
      `(15 min runtime / 48 tool calls) is consumed 5 min per spawn and is NEVER released, ` +
      `so a shell session can spawn only ~3 subagents in total. No data race observed (admission is synchronous).`,
    ms: t.ms,
    detail: { admitted, denied: denied.map((d) => d.output.slice(0, 80)) },
  });
}

async function M2(): Promise<void> {
  const child = [callRound([{ name: "shell_exec", input: { command: "echo pwned" } }])];
  const spawn = spawnToolWith(child);
  const t = await timed(async () => spawn.invoke({ task: "try shell", mode: "general", label: "m2" }));
  const out = t.value.output;
  const enforced = !out.includes("pwned");
  record({
    id: "M2",
    area: "multi-agent",
    what: "subagent calls shell_exec (mode read_only AND general)",
    expected: "read_only forbids shell — enforcement check",
    verdict: enforced ? "PASS" : "FAIL",
    observed:
      `enforced at three layers: tool list omits shell_exec, child policy shell=deny, child io.requestApproval always false. ` +
      `Result: ${JSON.stringify(out.slice(-90))}`,
    ms: t.ms,
  });
}

async function M3(): Promise<void> {
  const big = "x".repeat(1_500_000);
  const child = [[{ kind: "text_delta", text: big }, { kind: "model_end" }] as Partial<NormalizedEvent>[]];
  const spawn = spawnToolWith(child);
  const t = await timed(async () => spawn.invoke({ task: "huge output", label: "m3" }));
  const len = t.value.output.length;
  record({
    id: "M3",
    area: "multi-agent",
    what: "subagent returns >1 MB of text",
    expected: "overflow handler / truncation",
    verdict: len > 1_000_000 ? "RISK" : "PASS",
    observed:
      `child produced 1.5 MB → parent tool result is ${len} chars. There is NO cap on a child summary ` +
      `(quarantineChildSummary only prepends a marker); it lands verbatim in the parent's history and next prompt.`,
    ms: t.ms,
    rssDeltaMb: t.rssDeltaMb,
    detail: { returnedChars: len },
  });
}

async function M4(): Promise<void> {
  // (a) infinite tool loop in the child.
  const loop = Array.from({ length: 40 }, (_, i) =>
    callRound([{ name: "read_file", input: { path: "hello.txt" }, id: `loop-${i}` }]),
  );
  const spawnLoop = spawnToolWith(loop);
  const tA = await timed(async () => spawnLoop.invoke({ task: "loop forever", label: "m4a", max_tool_calls: 50 }));
  record({
    id: "M4a",
    area: "multi-agent",
    what: "subagent stuck in a tool loop",
    expected: "max_tool_calls stops it",
    verdict: tA.ms < 30_000 ? "PASS" : "FAIL",
    observed: `stopped by the child's unique-signature budget in ${Math.round(tA.ms)}ms (identical calls also collapse to one slot)`,
    ms: tA.ms,
  });

  // (b) child provider that never responds → is there a wall-clock timeout?
  const spawnHang = spawnToolWith([], true);
  const HANG_MS = 4000;
  const tB = await timed(async () =>
    Promise.race([
      spawnHang.invoke({ task: "hang", label: "m4b" }).then(() => "returned"),
      new Promise<string>((r) => setTimeout(() => r("still-running"), HANG_MS)),
    ]),
  );
  record({
    id: "M4b",
    area: "multi-agent",
    what: "subagent hangs (provider never responds)",
    expected: "subagent timeout",
    verdict: tB.value === "still-running" ? "RISK" : "PASS",
    observed:
      tB.value === "still-running"
        ? `still running after ${HANG_MS}ms — the reservation's maxRuntimeMs (5 min) is ACCOUNTING ONLY; ` +
          `no timer, no AbortSignal, no cancellation path. The parent turn blocks indefinitely.`
        : "returned before the probe deadline",
    ms: tB.ms,
  });
}

// ============================================================ 2.5 SANDBOX

async function S1(): Promise<void> {
  const has = Bun.spawnSync(["which", "docker"]).exitCode === 0;
  if (!has) {
    record({
      id: "S1",
      area: "sandbox",
      what: "docker from shell_exec",
      expected: "docker-in-docker allowed / blocked?",
      verdict: "SKIP",
      observed: "docker binary not on PATH on this host",
      ms: 0,
    });
    return;
  }
  // `docker info` — same reachability question, no image pull, no download.
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: "docker info --format '{{.ServerVersion}}'" } }])],
      async () => true,
    ),
  );
  const r = t.value.results[0];
  record({
    id: "S1",
    area: "sandbox",
    what: "docker reachable from shell_exec (info probe, no pull)",
    expected: "docker-in-docker allowed / blocked?",
    verdict: r?.isError === false ? "RISK" : "INFO",
    observed: `isError=${r?.isError} → ${JSON.stringify((r?.output ?? "").slice(0, 80))}; nothing in keryx filters docker (mode=${resolveShellSandboxMode(process.env)})`,
    ms: t.ms,
  });
}

async function S2(): Promise<void> {
  const MB = 64;
  const out = path.join(FIX_ROOT, "dd-test.bin");
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound([{ name: "shell_exec", input: { command: `dd if=/dev/zero of=${out} bs=1m count=${MB} 2>&1 | tail -1` } }])],
      async () => true,
    ),
  );
  const size = existsSync(out) ? statSync(out).size / 1024 / 1024 : 0;
  rmSync(out, { force: true });
  record({
    id: "S2",
    area: "sandbox",
    what: `dd ${MB} MiB into the workspace`,
    expected: "disk quota on the sandbox?",
    verdict: size >= MB ? "RISK" : "PASS",
    observed: `wrote ${size.toFixed(0)} MiB unimpeded — the sandbox profile has writable roots but NO size/quota/inode limit`,
    ms: t.ms,
  });
}

async function S3(): Promise<void> {
  const launcher = detectSandboxLauncher();
  const probes: string[] = [
    // closed loopback port + a hostname that must not resolve
    "(nc -z -w 2 127.0.0.1 9 && echo open) || echo closed",
    "getent hosts internal-service || host internal-service 2>/dev/null || echo dns-fail",
  ];
  if (ALLOW_EGRESS) probes.push("curl -sS -m 6 -o /dev/null -w '%{http_code}' https://example.com");
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound(probes.map((c, i) => ({ name: "shell_exec", input: { command: c }, id: `s3-${i}` })))],
      async () => true,
    ),
  );
  const rows = t.value.results.map((r) => (r.output.split("\n")[0] ?? "").slice(0, 40));
  record({
    id: "S3",
    area: "sandbox",
    what: "network egress from shell_exec",
    expected: "egress allowed? host-restricted?",
    verdict: ALLOW_EGRESS ? "INFO" : "INFO",
    observed:
      `mode=${resolveShellSandboxMode(process.env)} (default off ⇒ full host network, no allowlist). ` +
      `launcher=${launcher.available ? "available" : `unavailable (${launcher.reason ?? "?"})`}; probes → ${rows.join(" | ")}` +
      (ALLOW_EGRESS ? "" : "; external egress pair-test skipped (pass --allow-egress to run it)"),
    ms: t.ms,
    detail: { allowEgress: ALLOW_EGRESS, launcher },
  });
}

async function S4(): Promise<void> {
  const cmds =
    process.platform === "darwin"
      ? ["ls /proc/1/environ 2>&1 | head -1", "ps -p 1 -o comm= 2>&1", "ps ax | wc -l"]
      : ["cat /proc/1/environ 2>&1 | head -c 60", "ps -p 1 -o comm=", "ps ax | wc -l"];
  const t = await timed(async () =>
    runTurn(
      shellTools(FIX_ROOT),
      [callRound(cmds.map((c, i) => ({ name: "shell_exec", input: { command: c }, id: `s4-${i}` })))],
      async () => true,
    ),
  );
  const rows = t.value.results.map((r) => (r.output.split("\n")[0] ?? "(empty)").slice(0, 40));
  record({
    id: "S4",
    area: "sandbox",
    what: "other-process visibility",
    expected: "process isolation?",
    verdict: "RISK",
    observed: `no PID namespace on either platform — the agent shell sees the full host process table: ${rows.join(" | ")}`,
    ms: t.ms,
  });
}

// ============================================================ 2.6 LONGEVITY

function fdCount(): number {
  const r = Bun.spawnSync(["bash", "-c", `lsof -p ${process.pid} 2>/dev/null | wc -l`]);
  return Number.parseInt(new TextDecoder().decode(r.stdout).trim(), 10) || -1;
}

async function L1(): Promise<void> {
  const run = makeCommandRunner(FIX_ROOT);
  const fd0 = fdCount();
  const rss0 = rssMb();
  const t = await timed(async () => {
    for (let i = 0; i < 100; i++) await run("ls -la /tmp");
  });
  Bun.gc(true);
  const fd1 = fdCount();
  const rss1 = rssMb();
  record({
    id: "L1",
    area: "longevity",
    what: "100 sequential shell_exec runs",
    expected: "no fd leak, no RSS growth",
    verdict: fd1 - fd0 > 20 || rss1 - rss0 > 60 ? "RISK" : "PASS",
    observed: `fd ${fd0}→${fd1} (Δ${fd1 - fd0}), RSS ${rss0.toFixed(0)}→${rss1.toFixed(0)} MiB (Δ${(rss1 - rss0).toFixed(1)}), ${Math.round(t.ms / 100)}ms per spawn`,
    ms: t.ms,
    rssDeltaMb: rss1 - rss0,
    detail: { fdDelta: fd1 - fd0 },
  });
}

async function L2(): Promise<void> {
  // Parent writes inside the workspace, then a child reads it back.
  const inside = "sub.log";
  const outside = path.join(tmpdir(), "keryx-stress-outside.log");
  writeFileSync(outside, "outside-the-root\n");
  await runTurn(
    shellTools(FIX_ROOT),
    [callRound([{ name: "shell_exec", input: { command: `echo from-parent > ${inside}` } }])],
    async () => true,
  );
  const child = [callRound([{ name: "read_file", input: { path: inside } }])];
  const spawn = spawnToolWith(child);
  const t = await timed(async () => spawn.invoke({ task: "read the log", label: "l2" }));
  const tools = builtinReadOnlyTools(FIX_ROOT);
  const readTool = tools.find((x) => x.definition.name === "read_file")!;
  const escape = await readTool.invoke({ path: outside });
  rmSync(outside, { force: true });
  record({
    id: "L2",
    area: "longevity",
    what: "parent → file → subagent handoff",
    expected: "is FS-mediated inter-agent messaging allowed?",
    verdict: escape.isError ? "INFO" : "FAIL",
    observed:
      `inside the workspace: allowed (shared cwd, no isolation between parent and child). ` +
      `Outside the root: ${JSON.stringify(escape.output.slice(0, 60))} — read tools are confined, but shell_exec is not.`,
    ms: t.ms,
  });
}

async function L3(): Promise<void> {
  bigFile = makeBigFile("l3-big.bin", BIG_MB);
  const tools = builtinReadOnlyTools(FIX_ROOT);
  const readTool = tools.find((x) => x.definition.name === "read_file")!;
  Bun.gc(true);
  const before = rssMb();
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, rssMb());
  }, 20);
  const t = await timed(async () => readTool.invoke({ path: path.basename(bigFile) }));
  clearInterval(sampler);
  record({
    id: "L3",
    area: "longevity",
    what: `read_file on a ${BIG_MB} MiB file`,
    expected: "partial read / error / timeout",
    verdict: peak - before > BIG_MB / 2 ? "RISK" : "PASS",
    observed:
      `returned ${t.value.output.length} chars (20 KB cap) after loading the whole file: peak RSS +${(peak - before).toFixed(0)} MiB, ${Math.round(t.ms)}ms. ` +
      `No streaming, no size pre-check — the cap is applied AFTER the full read.`,
    ms: t.ms,
    rssDeltaMb: peak - before,
    detail: { fileMb: BIG_MB, outputChars: t.value.output.length },
  });
}

// ------------------------------------------------------------------- runner

const SUITE: Record<string, () => Promise<void>> = {
  P1, P2, P3, P4,
  C1, C2, C3,
  T1, T2, T3, T4,
  M1, M2, M3, M4,
  S1, S2, S3, S4,
  L1, L2, L3,
};

async function main(): Promise<void> {
  console.log(`keryx shell stress — root=${FIX_ROOT}`);
  console.log(
    `config: sandbox-shell=${resolveShellSandboxMode(process.env)} maxToolCalls=${resolveAgentMaxToolCalls()} ` +
      `(default ${DEFAULT_MAX_TOOL_CALLS}) platform=${process.platform} egress=${ALLOW_EGRESS}\n`,
  );
  makeFixtures();

  for (const [id, fn] of Object.entries(SUITE)) {
    if (!selected(id)) continue;
    try {
      await fn();
    } catch (cause) {
      record({
        id,
        area: "harness",
        what: "test threw",
        expected: "no exception",
        observed: `EXCEPTION: ${cause instanceof Error ? cause.message : String(cause)}`,
        verdict: "FAIL",
        ms: 0,
      });
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUT_DIR, `stress-${stamp}.json`);
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        platform: process.platform,
        bun: Bun.version,
        sandboxShellMode: resolveShellSandboxMode(process.env),
        maxToolCalls: resolveAgentMaxToolCalls(),
        allowEgress: ALLOW_EGRESS,
        findings,
      },
      null,
      2,
    )}\n`,
  );

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.verdict] = (acc[f.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nsummary: ${JSON.stringify(counts)}`);
  console.log(`report:  ${jsonPath}`);

  rmSync(FIX_ROOT, { recursive: true, force: true });
  // spawn_subagent schedules a 15s fleet-cleanup timer per child; don't wait.
  process.exit(0);
}

await main();

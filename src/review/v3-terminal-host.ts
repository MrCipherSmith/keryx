import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type {
  ReviewV3CliController,
  ReviewV3CliFactory,
  ReviewV3CliPlanInput,
} from "../commands/review-agents";
import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import type { ReviewV3Admission, ReviewV3SpawnInput } from "./v3/types";
import {
  createReviewPlan,
  createReviewRuntimePlanRegistration,
  type ReviewRuntimePlanRegistration,
} from "./v3-planning";
import type { ReviewV3Host, ReviewV3HostRuntime } from "./v3-host";

export const REVIEW_V3_ROOT_SOCKET_ENV = "KERYX_REVIEW_V3_ROOT_SOCKET";
export const REVIEW_V3_ROOT_TOKEN_ENV = "KERYX_REVIEW_V3_ROOT_TOKEN";
export const REVIEW_V3_ROOT_RUNS_ROOT_ENV = "KERYX_REVIEW_V3_ROOT_RUNS_ROOT";
export const DEFAULT_REVIEW_V3_ROOT_MAX_LINE_BYTES = 2 * 1024 * 1024;

const ROOT_TOOL_NAMES = {
  start: "review_v3_start",
  plan: "review_v3_plan",
  spawn: "review_v3_spawn",
  status: "review_v3_status",
  wait: "review_v3_wait",
  result: "review_v3_result",
  cancel: "review_v3_cancel",
} as const;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

type RootToolOperation = keyof typeof ROOT_TOOL_NAMES;

export type ReviewV3TerminalRequest =
  | { readonly operation: RootToolOperation; readonly input: Readonly<Record<string, unknown>> }
  | { readonly operation: "capabilities"; readonly runId: string; readonly adapterId?: string };

export type ReviewV3TerminalResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: "invalid_request" | "unauthorized" | "tool_error" | "controller_error"; readonly message: string };

interface RootWireRequest {
  readonly v: 1;
  readonly id: string;
  readonly token: string;
  readonly request: ReviewV3TerminalRequest;
}

interface RootWireResponse {
  readonly v: 1;
  readonly id: string;
  readonly response: ReviewV3TerminalResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function parseWireRequest(line: string): RootWireRequest | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return undefined; }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["v", "id", "token", "request"])) return undefined;
  if (parsed.v !== 1 || typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 200) return undefined;
  if (typeof parsed.token !== "string" || !isRecord(parsed.request)) return undefined;
  const request = parsed.request;
  if (typeof request.operation !== "string") return undefined;
  if (request.operation === "capabilities") {
    if (!hasExactKeys(request, ["operation", "runId"], ["adapterId"])) return undefined;
    if (typeof request.runId !== "string" || request.runId.trim() === "") return undefined;
    if (request.adapterId !== undefined && (typeof request.adapterId !== "string" || request.adapterId.trim() === "")) return undefined;
  } else {
    if (!(request.operation in ROOT_TOOL_NAMES) || !hasExactKeys(request, ["operation", "input"]) || !isRecord(request.input)) return undefined;
    if (!validToolInput(request.operation as RootToolOperation, request.input)) return undefined;
  }
  return parsed as unknown as RootWireRequest;
}

function inputKeys(input: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  return hasExactKeys(input, required, optional);
}

function validToolInput(operation: RootToolOperation, input: Readonly<Record<string, unknown>>): boolean {
  switch (operation) {
    case "start":
      return inputKeys(input, ["run_id", "revision", "config"]);
    case "plan":
      return inputKeys(input, ["run_id", "plan", "waves"]);
    case "spawn":
      return inputKeys(input, ["run_id", "task_id", "attempt", "entity", "role", "adapter_id", "scope_ids"], ["task", "idempotency_key", "skill_ref", "wave_id", "max_runtime_ms"]);
    case "status":
      return inputKeys(input, ["run_id"], ["dispatch_id"]);
    case "wait":
    case "result":
      return inputKeys(input, ["run_id", "dispatch_id"]);
    case "cancel":
      return inputKeys(input, ["run_id", "reason"], ["dispatch_id"]);
  }
}

async function assertSafeRunTarget(runsRoot: string, runId: unknown): Promise<void> {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("invalid Review V3 run id");
  const expected = path.join(runsRoot, runId);
  try {
    const canonical = await realpath(expected);
    if (canonical !== expected || path.dirname(canonical) !== runsRoot) {
      throw new Error("Review V3 run target must not be a symlink or escape the bound runs root");
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

function authorized(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function outputValue(result: InteractiveToolResult): ReviewV3TerminalResponse {
  if (result.isError) return { ok: false, code: "tool_error", message: result.output || "review V3 host tool failed" };
  try { return { ok: true, value: JSON.parse(result.output) as unknown }; }
  catch { return { ok: true, value: result.output }; }
}

function writeResponse(socket: Socket, response: RootWireResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface ReviewV3TerminalHost {
  readonly socketPath: string;
  readonly runsRoot: string;
  /** The bearer is returned only to the foreground operator that started this host. */
  readonly token: string;
  readonly env: Readonly<Record<string, string>>;
  readonly close: () => Promise<{ readonly stopped: boolean; readonly activeRunIds: readonly string[] }>;
}

/**
 * Start the local root controller endpoint used by an ordinary terminal/Codex
 * harness. The endpoint is Unix-only, owner-only, bearer-authenticated and
 * exposes only the seven Review V3 host tools plus capability inspection.
 */
export async function startReviewV3TerminalHost(options: {
  readonly host: ReviewV3Host;
  readonly runtime: ReviewV3HostRuntime;
  readonly runsRoot: string;
  readonly tempParent?: string;
  readonly token?: string;
  readonly maxLineBytes?: number;
}): Promise<ReviewV3TerminalHost> {
  if (process.platform === "win32") throw new Error("Review V3 terminal host currently requires a Unix domain socket");
  await mkdir(path.resolve(options.runsRoot), { recursive: true });
  const runsRoot = await realpath(path.resolve(options.runsRoot));
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (Buffer.byteLength(token, "utf8") < 32) throw new Error("Review V3 root bearer must be at least 32 bytes");
  const root = await mkdtemp(path.join(options.tempParent ?? tmpdir(), "keryx-review-v3-root-"));
  await chmod(root, 0o700);
  const socketPath = path.join(root, "controller.sock");
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_REVIEW_V3_ROOT_MAX_LINE_BYTES;
  const tools = new Map<string, InteractiveTool>(options.host.tools(options.runtime).map((tool) => [tool.definition.name, tool]));
  const sockets = new Set<Socket>();
  let transportClosed = false;
  let fullyClosed = false;
  let lastCloseResult: { readonly stopped: boolean; readonly activeRunIds: readonly string[] } | undefined;

  const invoke = async (request: ReviewV3TerminalRequest): Promise<ReviewV3TerminalResponse> => {
    if (request.operation === "capabilities") {
      try {
        await assertSafeRunTarget(runsRoot, request.runId);
        return { ok: true, value: (await options.host.controller(request.runId)).capabilities(request.adapterId) };
      }
      catch { return { ok: false, code: "controller_error", message: "review V3 capability inspection failed" }; }
    }
    const tool = tools.get(ROOT_TOOL_NAMES[request.operation]);
    if (tool === undefined) return { ok: false, code: "controller_error", message: "review V3 host tool is unavailable" };
    try {
      await assertSafeRunTarget(runsRoot, request.input.run_id);
      if (request.operation === "start") {
        const { config, ...hostInput } = request.input;
        const result = outputValue(await tool.invoke(hostInput));
        if (!result.ok) return result;
        const actualConfig = isRecord(result.value) ? result.value.config : undefined;
        if (!isDeepStrictEqual(actualConfig, config)) {
          const cancel = tools.get(ROOT_TOOL_NAMES.cancel);
          await cancel?.invoke({ run_id: request.input.run_id, reason: "requested terminal configuration did not match host configuration" });
          return { ok: false, code: "tool_error", message: "requested Review V3 configuration does not match the controller host configuration" };
        }
        return result;
      }
      return outputValue(await tool.invoke({ ...request.input }));
    }
    catch { return { ok: false, code: "controller_error", message: "review V3 host invocation failed" }; }
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) { socket.destroy(); return; }
      buffered += chunk;
      if (Buffer.byteLength(buffered, "utf8") > maxLineBytes) { socket.destroy(); return; }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const wire = parseWireRequest(buffered.slice(0, newline));
      if (wire === undefined) { socket.destroy(); return; }
      if (!authorized(wire.token, token)) {
        writeResponse(socket, { v: 1, id: wire.id, response: { ok: false, code: "unauthorized", message: "review V3 root authorization failed" } });
        return;
      }
      void invoke(wire.request).then((response) => writeResponse(socket, { v: 1, id: wire.id, response }));
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    socketPath,
    runsRoot,
    token,
    env: {
      [REVIEW_V3_ROOT_SOCKET_ENV]: socketPath,
      [REVIEW_V3_ROOT_TOKEN_ENV]: token,
      [REVIEW_V3_ROOT_RUNS_ROOT_ENV]: runsRoot,
    },
    async close() {
      if (fullyClosed) return lastCloseResult ?? { stopped: true, activeRunIds: [] };
      if (!transportClosed) {
        transportClosed = true;
        for (const socket of sockets) socket.destroy();
        await closeServer(server).catch(() => undefined);
      }
      const result = await options.host.close();
      lastCloseResult = result;
      if (result.stopped) {
        fullyClosed = true;
        await rm(root, { recursive: true, force: true });
      }
      return result;
    },
  };
}

export interface ReviewV3TerminalClient {
  readonly invoke: (request: ReviewV3TerminalRequest, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
}

export function createReviewV3TerminalClient(options: {
  readonly socketPath: string;
  readonly token: string;
  readonly timeoutMs?: number;
}): ReviewV3TerminalClient {
  if (!path.isAbsolute(options.socketPath)) throw new Error("Review V3 root socket path must be absolute");
  if (Buffer.byteLength(options.token, "utf8") < 32) throw new Error("Review V3 root bearer is invalid");
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    invoke(request, invokeOptions = {}) {
      return new Promise<unknown>((resolve, reject) => {
        const id = randomUUID();
        const socket = createConnection(options.socketPath);
        socket.setEncoding("utf8");
        let buffered = "";
        let settled = false;
        const finish = (error?: Error, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          invokeOptions.signal?.removeEventListener("abort", onAbort);
          socket.destroy();
          if (error === undefined) resolve(value);
          else reject(error);
        };
        const onAbort = (): void => finish(new Error("review V3 root request aborted"));
        const timer = setTimeout(() => finish(new Error("review V3 root request timed out")), timeoutMs);
        socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, id, token: options.token, request })}\n`));
        socket.on("data", (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          let wire: unknown;
          try { wire = JSON.parse(buffered.slice(0, newline)); }
          catch { finish(new Error("review V3 root endpoint returned invalid JSON")); return; }
          if (!isRecord(wire) || wire.v !== 1 || wire.id !== id || !isRecord(wire.response) || typeof wire.response.ok !== "boolean") {
            finish(new Error("review V3 root endpoint returned an invalid response"));
            return;
          }
          if (!wire.response.ok) {
            const message = typeof wire.response.message === "string" ? wire.response.message : "review V3 root request failed";
            const error = new Error(message);
            if (typeof wire.response.code === "string") Object.assign(error, { code: wire.response.code });
            finish(error);
            return;
          }
          finish(undefined, wire.response.value);
        });
        socket.on("error", (error) => finish(error));
        socket.on("close", () => finish(new Error("review V3 root endpoint closed without a response")));
        invokeOptions.signal?.addEventListener("abort", onAbort, { once: true });
        if (invokeOptions.signal?.aborted) onAbort();
      });
    },
  };
}

export function reviewV3TerminalClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReviewV3TerminalClient {
  const socketPath = env[REVIEW_V3_ROOT_SOCKET_ENV];
  const token = env[REVIEW_V3_ROOT_TOKEN_ENV];
  if (socketPath === undefined || token === undefined) throw new Error("review V3 root environment is incomplete");
  return createReviewV3TerminalClient({ socketPath, token });
}

async function runIdFromDir(runDir: string, runsRoot: string): Promise<string> {
  const canonicalRoot = await realpath(path.resolve(runsRoot));
  const candidate = path.resolve(runDir);
  const candidateParent = await realpath(path.dirname(candidate));
  if (candidateParent !== canonicalRoot) throw new Error(`--run-dir must be an immediate child of the bound Review V3 runs root ${canonicalRoot}`);
  try {
    const canonicalCandidate = await realpath(candidate);
    if (canonicalCandidate !== candidate || path.dirname(canonicalCandidate) !== canonicalRoot) {
      throw new Error("--run-dir must not be a symlink or escape the bound Review V3 runs root");
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const runId = path.basename(candidate);
  if (runId === "." || runId === path.parse(candidate).root || runId.trim() === "") throw new Error("review V3 run directory has no run id");
  return runId;
}

function hostSpawnInput(runId: string, input: ReviewV3SpawnInput): Record<string, unknown> {
  return {
    run_id: runId,
    task_id: input.taskId,
    ...(input.task === undefined ? {} : { task: input.task }),
    attempt: input.attempt,
    ...(input.idempotencyKey === undefined ? {} : { idempotency_key: input.idempotencyKey }),
    entity: input.entity,
    role: input.role,
    adapter_id: input.adapterId,
    ...(input.skillRef === undefined ? {} : { skill_ref: input.skillRef }),
    scope_ids: input.scopeIds,
    ...(input.waveId === undefined ? {} : { wave_id: input.waveId }),
    ...(input.maxRuntimeMs === undefined ? {} : { max_runtime_ms: input.maxRuntimeMs }),
  };
}

function hostPlanInput(runId: string, input: ReviewV3CliPlanInput): Record<string, unknown> {
  return {
    run_id: runId,
    plan: input.plan,
    waves: input.waves.map((wave) => ({ wave_id: wave.waveId, review_round: wave.reviewRound, assignment_ids: wave.assignmentIds })),
  };
}

function parseAdmission(value: unknown): ReviewV3Admission {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error("review V3 root endpoint returned an invalid admission");
  if (value.ok) {
    if (typeof value.dispatchId !== "string" || value.dispatchId.trim() === "" || typeof value.reused !== "boolean") {
      throw new Error("review V3 root endpoint returned an invalid admission");
    }
    return { ok: true, dispatchId: value.dispatchId, reused: value.reused };
  }
  if (typeof value.code !== "string" || typeof value.message !== "string" || value.message.trim() === "") {
    throw new Error("review V3 root endpoint returned an invalid admission refusal");
  }
  return value as unknown as ReviewV3Admission;
}

function parsePlanRegistration(value: unknown): Pick<ReviewRuntimePlanRegistration, "planHash" | "planVersion" | "revision" | "waves"> {
  if (!isRecord(value) || typeof value.planHash !== "string" || !/^[0-9a-f]{64}$/.test(value.planHash) ||
      !Number.isSafeInteger(value.planVersion) || (value.planVersion as number) < 1 ||
      typeof value.revision !== "string" || value.revision.trim() === "" || !Array.isArray(value.waves) ||
      value.waves.some((wave) => !isRecord(wave) || !hasExactKeys(wave, ["waveId", "reviewRound"]) ||
        typeof wave.waveId !== "string" || wave.waveId.trim() === "" || !Number.isSafeInteger(wave.reviewRound) || (wave.reviewRound as number) < 1)) {
    throw new Error("review V3 root endpoint returned an invalid plan registration");
  }
  return value as unknown as Pick<ReviewRuntimePlanRegistration, "planHash" | "planVersion" | "revision" | "waves">;
}

/** A full root CLI binding. Possession of its client bearer is the authority. */
export function createReviewV3TerminalCliFactory(
  client: ReviewV3TerminalClient,
  options: { readonly runsRoot: string },
): ReviewV3CliFactory {
  const controller = (runId: string): ReviewV3CliController => ({
    capabilities: (adapterId?: string) => client.invoke({ operation: "capabilities", runId, ...(adapterId === undefined ? {} : { adapterId }) }),
    status: (dispatchId?: string) => client.invoke({ operation: "status", input: { run_id: runId, ...(dispatchId === undefined ? {} : { dispatch_id: dispatchId }) } }),
    spawn: async (input) => parseAdmission(await client.invoke({ operation: "spawn", input: hostSpawnInput(runId, input) })),
    wait: (dispatchId) => client.invoke({ operation: "wait", input: { run_id: runId, dispatch_id: dispatchId } }),
    cancel: (dispatchId, reason) => client.invoke({ operation: "cancel", input: { run_id: runId, ...(dispatchId === undefined ? {} : { dispatch_id: dispatchId }), reason } }),
    result: (dispatchId) => client.invoke({ operation: "result", input: { run_id: runId, dispatch_id: dispatchId } }),
  });
  return {
    open: async (runDir) => controller(await runIdFromDir(runDir, options.runsRoot)),
    create: async (runDir, input) => {
      const runId = await runIdFromDir(runDir, options.runsRoot);
      if (runId !== input.runId) throw new Error("--run-dir basename must equal --run-id for a Review V3 root host");
      if (input.config.costMode !== "cost-unknown") throw new Error("Review V3 terminal host currently supports only cost-unknown runs");
      await client.invoke({ operation: "start", input: { run_id: input.runId, revision: input.revision, config: input.config } });
      return controller(runId);
    },
    registerPlan: async (runDir, input) => {
      const expected = createReviewRuntimePlanRegistration(createReviewPlan(input.plan), input.waves);
      const actual = parsePlanRegistration(await client.invoke({ operation: "plan", input: hostPlanInput(await runIdFromDir(runDir, options.runsRoot), input) }));
      if (!isDeepStrictEqual(actual, {
        planHash: expected.planHash,
        planVersion: expected.planVersion,
        revision: expected.revision,
        waves: expected.waves,
      })) throw new Error("review V3 root endpoint registered a different plan");
      return expected;
    },
  };
}

export function createReviewV3TerminalCliFactoryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReviewV3CliFactory {
  const runsRoot = env[REVIEW_V3_ROOT_RUNS_ROOT_ENV];
  if (runsRoot === undefined) throw new Error("review V3 root environment is incomplete");
  return createReviewV3TerminalCliFactory(reviewV3TerminalClientFromEnv(env), { runsRoot });
}

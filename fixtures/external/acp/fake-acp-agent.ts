// A scripted fake ACP AGENT for keryx's ACP-client tests (flow 292, AC1-AC10).
//
// Run as `bun fake-acp-agent.ts <scenario.json>`. It speaks the real wire —
// newline-delimited JSON-RPC 2.0 on stdin/stdout — so the keryx side under test
// is exercised over a real pipe with no network and no vendor CLI installed.
//
// It is NOT evidence of any vendor's behaviour. It does exactly what its
// scenario says, and it LOGS every message it receives (and every answer it
// got to a request it made) to `scenario.log` as JSONL, so a test asserts on
// what reached the agent instead of on what keryx believes it sent.
//
// Scenario (all fields optional unless noted):
//   log               absolute path of the JSONL log (required)
//   protocolVersion   answered on initialize (default 1)
//   agentInfo         answered on initialize
//   agentCapabilities answered on initialize
//   steps             run on session/prompt, in order (see `runStep`)
//   stopReason        the prompt's answer (default "end_turn")
//   hang              never answer session/prompt, and ignore session/cancel
//   afterPrompt       raw requests ({method, params}) written in the same write
//                     as, and right behind, the prompt's answer
//
// An `update` step may carry `session` to send it for another session id.
//
// The string "{{cwd}}" anywhere in a step is replaced with the cwd keryx sent in
// session/new — the disposable worktree.

import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const scenarioPath = process.argv[2];
if (scenarioPath === undefined) {
  process.stderr.write("usage: fake-acp-agent.ts <scenario.json>\n");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const logPath = scenario.log;

function log(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

let cwd = "";
let sessionId = "fake-session-1";
let nextId = 0;
const pending = new Map();

function substitute(value) {
  if (typeof value === "string") return value.split("{{cwd}}").join(cwd);
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = substitute(inner);
    return out;
  }
  return value;
}

function request(method, params) {
  nextId += 1;
  const id = `fake-${nextId}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

function update(body, session) {
  send({ method: "session/update", params: { sessionId: session ?? sessionId, update: substitute(body) } });
}

async function runSteps(steps) {
  for (const step of steps ?? []) await runStep(step);
}

async function runStep(step) {
  if (step.update !== undefined) {
    update(step.update, step.session);
    return;
  }
  if (step.say !== undefined) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
    return;
  }
  if (step.request !== undefined) {
    const response = await request(step.request.method, substitute(step.request.params ?? {}));
    log({ kind: "response", as: step.as ?? step.request.method, response });
    return;
  }
  if (step.permission !== undefined) {
    const params = substitute({ sessionId, ...step.permission });
    const response = await request("session/request_permission", params);
    log({ kind: "response", as: step.as ?? "permission", response });
    const outcome = response.result?.outcome;
    const chosen =
      outcome?.outcome === "selected"
        ? (params.options ?? []).find((option) => option.optionId === outcome.optionId)
        : undefined;
    const allowed = chosen !== undefined && String(chosen.kind).startsWith("allow");
    await runSteps(allowed ? step.onAllow : step.onDeny);
    return;
  }
  if (step.stat !== undefined) {
    const target = substitute(step.stat);
    log({ kind: "stat", path: target, exists: existsSync(target) });
    return;
  }
  if (step.symlink !== undefined) {
    // The agent's OWN filesystem call: a link inside its cwd pointing anywhere.
    symlinkSync(substitute(step.symlink.target), path.join(cwd, step.symlink.path));
    log({ kind: "own-symlink", path: path.join(cwd, step.symlink.path) });
    return;
  }
  if (step.writeOwnFile !== undefined) {
    // The agent's OWN write — no ACP call. keryx never sees this.
    const target = path.join(cwd, step.writeOwnFile.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, step.writeOwnFile.content);
    log({ kind: "own-write", path: target });
    return;
  }
}

let promptId;

async function onRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: scenario.protocolVersion ?? 1,
        agentCapabilities: scenario.agentCapabilities ?? {},
        authMethods: [],
        ...(scenario.agentInfo === undefined ? {} : { agentInfo: scenario.agentInfo }),
      },
    });
    return;
  }
  if (method === "session/new") {
    cwd = params.cwd;
    send({ id, result: { sessionId } });
    return;
  }
  if (method === "session/prompt") {
    promptId = id;
    await runSteps(scenario.steps);
    if (scenario.hang === true) return;
    // `afterPrompt` requests go out in the SAME write as the prompt's answer,
    // right behind it: they are in the pipe before keryx can stop the agent.
    const answer = { jsonrpc: "2.0", id, result: { stopReason: scenario.stopReason ?? "end_turn" } };
    const late = (scenario.afterPrompt ?? []).map((message, index) => ({
      jsonrpc: "2.0",
      id: `late-${index}`,
      ...substitute(message),
    }));
    process.stdout.write([answer, ...late].map((message) => `${JSON.stringify(message)}\n`).join(""));
    return;
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.trim().length === 0) continue;
    const message = JSON.parse(line);
    log({ kind: "received", message });
    if ("method" in message && "id" in message) {
      void onRequest(message);
    } else if ("method" in message) {
      if (message.method === "session/cancel" && scenario.hang !== true && promptId !== undefined) {
        send({ id: promptId, result: { stopReason: "cancelled" } });
      }
    } else if ("id" in message) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle?.(message);
    }
  }
});
process.stdin.on("end", () => process.exit(0));

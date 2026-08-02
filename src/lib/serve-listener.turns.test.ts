// `keryx serve` executes a turn — over a real socket, through the real assembly.
//
// This file exists because of one finding. `POST /v1/turns` shipped answering
// `503 unavailable` to everything: `startServeListener` built the only
// production `ServeContext` without `submitTurn`, and `createSubmitTurn` had
// zero production callers. Nine of the twelve criteria that were supposed to
// prove the route worked had been verified through `handleServeRequest` with a
// runner injected by a test fixture, so every one of them was green against a
// listener that could not run a turn.
//
// So nothing here is injected that production does not inject:
//
//   - the listener is started by `startServeListener`, the function the CLI
//     calls, on port 0, and the bound port is read back from it;
//   - the runner is `assembleSubmitTurn`, the function `commands/serve.ts`
//     passes — not a stub, not a re-composition of its steps;
//   - the request goes over TCP with a real bearer token, through `fetch`.
//
// The provider resolves to the offline `FakeProvider`, because the fixture's
// config directory holds no saved provider and no API key. That is the real
// fail-closed path, not a substitution: `makeProvider` never reaches the network
// without a credential, so this suite is deterministic and offline while still
// exercising the assembly the operator gets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { registerProject } from "./project-registry";
import { defaultServeConfig, type ServeConfig } from "./serve-config";
import { issueServeToken, type ServeCredentialRecord } from "./serve-credential";
import { assembleSubmitTurn } from "./serve-runner";
import { startServeListener, type ServeListener } from "./serve-server";
import { readTurnEvents, readTurnRecord, type StreamEvent } from "./serve-turn-store";

let configDir = "";
let project = "";
let token = "";
let credential: ServeCredentialRecord;
let listener: ServeListener | undefined;
let origin = "";

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-r4c-socket-"));
  configDir = path.join(base, "config");
  project = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
  const issued = issueServeToken(configDir);
  if (!issued.ok) {
    throw new Error("fixture could not issue a token");
  }
  token = issued.token;
  credential = issued.record;
  registerProject(project, { dir: configDir });
});

afterEach(async () => {
  if (listener !== undefined) {
    await listener.drain();
    listener = undefined;
  }
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

function config(): ServeConfig {
  // Port 0: the OS chooses, and the bound port is read back below. A fixed port
  // is the flake this repository's testing rules forbid — two suites running at
  // once would fight over it.
  return defaultServeConfig(credential.id, { port: 0 });
}

/** Start the listener the CLI starts, and return its origin. */
async function listen(): Promise<string> {
  const outcome = await startServeListener({
    config: config(),
    credential: { status: "ok", record: credential },
    dir: configDir,
    // THE line under test. `commands/serve.ts` passes exactly this.
    makeSubmitTurn: assembleSubmitTurn,
  });
  if (!outcome.ok) {
    throw new Error(`listener refused to start: ${outcome.message}`);
  }
  listener = outcome.listener;
  return `http://127.0.0.1:${outcome.listener.port}`;
}

async function submit(prompt: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${origin}/v1/turns`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "1.0.0", project, prompt, ...extra }),
  });
}

describe("a listener the CLI can start executes a turn", () => {
  test("POST /v1/turns over a real socket is 202, not 503", async () => {
    // The blocker, stated as the assertion that would have caught it. 503 is
    // what this returned for every submission on a real `keryx serve`, and no
    // test in the suite could see it because none of them opened a socket.
    origin = await listen();

    const response = await submit("say something");

    expect(response.status).toBe(202);
    const body = (await response.json()) as { turnId: string; sessionId: string };
    expect(body.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // Distinct values, not merely two uuid-shaped strings. Production minted one
    // id and reported it as both, and the test that "covered" it asserted the
    // shape of each rather than that they differ.
    expect(body.sessionId).not.toBe(body.turnId);
  }, 30_000);

  test("the durable record and the event stream answer for the same turn", async () => {
    // AC2: the parity claimed through an injected runner, claimed again through
    // the listener. Submit, then read both views back over the same socket.
    origin = await listen();
    const accepted = (await (await submit("say something")).json()) as { turnId: string };

    const record = await fetch(`${origin}/v1/turns/${accepted.turnId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(record.status).toBe(200);
    const result = (await record.json()) as { turnId: string; outcome: string; origin: string };
    expect(result.turnId).toBe(accepted.turnId);
    expect(result.origin).toBe("remote:http");

    const events = await fetch(`${origin}/v1/turns/${accepted.turnId}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const stream = await events.text();
    // The stream is a view of the record, so the record's own reader must agree
    // with what the route served. Reading the store here is deliberate: the two
    // disagreeing is precisely the failure this asserts against.
    const stored = readTurnEvents(accepted.turnId, -1, configDir);
    expect(stored.ok).toBe(true);
    const kinds = stored.ok ? stored.value.map((e: StreamEvent) => e.kind) : [];
    expect(kinds).toContain("turn.started");
    expect(kinds.at(-1)).toBe("turn.finished");
    for (const event of stored.ok ? stored.value : []) {
      expect(stream).toContain(`id: ${event.seq}\n`);
    }
  }, 30_000);

  test("the terminal result is on disk under the turn the socket reported", async () => {
    // The record is the thing and the responses are views of it. If the id the
    // caller was handed does not name a record, every later request they make
    // is about a turn that does not exist.
    origin = await listen();
    const accepted = (await (await submit("say something")).json()) as { turnId: string; sessionId: string };

    const stored = readTurnRecord(accepted.turnId, configDir);
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.value.sessionId).toBe(accepted.sessionId);
      expect(stored.value.result?.outcome).toBeDefined();
    }
  }, 30_000);

  test("a writer that throws produces a bare 500, not a stack and a home path", async () => {
    // F-008. `Bun.serve` had no `error` handler and `handleServeRequest` no
    // try/catch, while the submit path calls writers `config-dir.ts` documents
    // as propagating EACCES/ENOSPC/EROFS. A disk-full or permission failure
    // escaped as Bun's default 500 page carrying the message and the stack —
    // including the absolute home-directory path the projects route was
    // specifically hardened to stop disclosing.
    //
    // Reproduced with a real filesystem failure rather than a thrown sentinel.
    // A regular file where the turn store's root directory belongs makes the
    // first `ensureKeryxSubdir` raise from inside the handler, exactly as EROFS
    // or ENOSPC would on a real host.
    //
    // Not a mode bit: `ensureKeryxSubdir` chmods every level it walks to 0o700,
    // so making the directory unwritable is undone by the code under test
    // before it can fail. Worth recording — the obvious fixture here is a
    // fixture that proves nothing.
    origin = await listen();
    writeFileSync(path.join(configDir, "turns"), "not a directory", "utf8");

    const response = await submit("say something");

    expect(response.status).toBe(500);
    const body = await response.text();
    // Says THAT it failed and nothing else. No errno, no path, no frame.
    expect(body).toContain("internal-error");
    expect(body).not.toMatch(/ENOTDIR|EEXIST|EACCES|ENOSPC|EROFS/);
    expect(body).not.toContain(configDir);
    expect(body).not.toContain(homedir());
    expect(body).not.toMatch(/\bat\s+\w+\s*\(/);
  }, 30_000);

  test("an unauthenticated submission never reaches the runner", async () => {
    // The control for the three above: they pass because the token is right,
    // not because the route stopped checking. Without this, wiring the runner
    // could have been proven by a listener that ran turns for anyone.
    origin = await listen();

    const response = await fetch(`${origin}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0.0", project, prompt: "say something" }),
    });

    expect(response.status).toBe(401);
    expect(readTurnEvents("00000000-0000-4000-8000-000000000000", -1, configDir)).toEqual({
      ok: true,
      value: [],
    });
  }, 30_000);
});

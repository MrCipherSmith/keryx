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
import { detectSandboxLauncher } from "../harness/process/sandbox/detect";
import { saveShellConfig } from "./shell-config";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
import { registerProject } from "./project-registry";
import { defaultServeConfig, type ServeConfig } from "./serve-config";
import { issueServeToken, type ServeCredentialRecord } from "./serve-credential";
import { assembleSubmitTurn } from "./serve-runner";
import { startServeListener, type ServeListener, type StartServeInput } from "./serve-server";
import { createSubmitTurn } from "./serve-turn";
import { keryxConfigDir } from "./config-dir";
import { listTurnIds, readTurnEvents, readTurnRecord, type StreamEvent } from "./serve-turn-store";

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
  // A saved provider and model, which is what an operator has after
  // `keryx shell` -> `/connect`. Without them the harness refuses at startup on
  // a missing provider precondition and every turn is recorded as FAILED — so
  // an unconfigured fixture cannot demonstrate the capability, and for one
  // round it silently did not: the record said `completed` because the
  // transport discarded the run's status, and the assertion below was satisfied
  // by a failure. `fake` keeps it offline; the model only has to be non-empty.
  saveShellConfig({ provider: "fake", model: "fake-model" }, configDir);
});

afterEach(async () => {
  if (listener !== undefined) {
    await listener.drain();
    listener = undefined;
  }
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

function config(profile: string): ServeConfig {
  // Port 0: the OS chooses, and the bound port is read back below. A fixed port
  // is the flake this repository's testing rules forbid — two suites running at
  // once would fight over it.
  return defaultServeConfig(credential.id, { port: 0, profile });
}

/**
 * Start the listener the CLI starts, and return its origin.
 *
 * `remote-read-only` by default, and that choice is the difference between this
 * suite proving something and not. The shipped default `remote-restricted`
 * resolves to a profile whose `requiredControls.isolation` is
 * `required-fail-closed`, so on any host without a sandbox launcher — including
 * every CI runner that has not installed bubblewrap — every turn is REFUSED.
 * A refusal is also 202, also emits `turn.started` then `turn.finished`, and
 * also has a defined `outcome`, which is exactly why the first version of this
 * file was green against a listener that never ran a turn. `remote-read-only`
 * requires no launcher, so the capability is actually exercised; the refusal
 * path has its own test below.
 */
async function listen(profile = "remote-read-only"): Promise<string> {
  // THE line under test: `commands/serve.ts` passes exactly `assembleSubmitTurn`.
  return listenWith(assembleSubmitTurn, profile);
}

/** The same real listener, with the runner factory supplied by the caller. */
async function listenWith(
  makeSubmitTurn: StartServeInput["makeSubmitTurn"],
  profile = "remote-read-only",
): Promise<string> {
  const outcome = await startServeListener({
    config: config(profile),
    credential: { status: "ok", record: credential },
    dir: configDir,
    makeSubmitTurn,
  });
  if (!outcome.ok) {
    throw new Error(`listener refused to start: ${outcome.message}`);
  }
  listener = outcome.listener;
  return `http://127.0.0.1:${outcome.listener.port}`;
}

/** An offline provider that answers with fixed text. No network, no transcript. */
class StubProvider implements ProviderPort {
  constructor(private readonly text: string) {}
  describe(): ProviderDescription {
    return {
      capabilities: {
        streaming: true,
        toolCalls: false,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "stub-provider" },
    };
  }
  async *stream(_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    let sequence = 0;
    const next = (body: Omit<NormalizedEvent, "sequence" | "attemptId">): NormalizedEvent => ({
      ...body,
      sequence: sequence++,
      attemptId: opts.attemptId,
    });
    yield next({ kind: "model_start" });
    yield next({ kind: "text_delta", text: this.text });
    yield next({ kind: "model_end" });
  }
}

async function submit(prompt: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${origin}/v1/turns`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "1.0.0", project, prompt, ...extra }),
  });
}

describe("a listener the CLI can start executes a turn", () => {
  test("a turn submitted over a real socket RUNS to completion", async () => {
    // The blocker, and then the blocker the fix for it introduced.
    //
    // First: `POST /v1/turns` answered 503 to everything on a real listener,
    // because the only production `ServeContext` omitted `submitTurn`. No test
    // could see it, because none of them opened a socket.
    //
    // Then: the socket suite written to close that asserted 202 and two
    // uuid-shaped ids — and passed on a turn that never ran, because the
    // production assembly omitted `containmentAvailable` and every submission
    // was refused. A refusal is also 202. So this asserts the OUTCOME and the
    // assistant text, which no shape-only assertion can satisfy.
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

    // The turn RAN, and the record says what the RUN said.
    //
    // NOT `outcome === "completed"`. There is no offline configuration in which
    // the production assembly completes a turn: `makeProvider` falls to
    // `FakeProvider` with no transcripts, which cannot answer, so the run
    // legitimately fails. An earlier version asserted `completed` here and was
    // green — on a turn that had failed, because the transport discarded the
    // run's status and reported success regardless. Asserting the value a
    // failure cannot produce is the point; asserting a value a failure DOES
    // produce is how that went unnoticed.
    //
    // What is asserted instead is everything the assembly is responsible for:
    // the record exists, the ids are distinct, the outcome tracks the run rather
    // than being invented, and the containment gate was not what stopped it.
    // The capability itself — assistant text reaching both views — is the next
    // test, through the same real listener with only the model replaced.
    const stored = readTurnRecord(body.turnId, configDir);
    expect(stored.ok).toBe(true);
    if (!stored.ok) {
      return;
    }
    // NOT `toBeDefined()`, which is satisfied by "completed" — the value this
      // assertion was rewritten to stop accepting. There is no offline
      // configuration in which the production assembly completes a turn, so the
      // honest statement is which outcomes ARE reachable.
      expect(["failed", "refused", "cancelled"]).toContain(stored.value.result?.outcome ?? "missing");
    expect(stored.value.result?.reasonCode).not.toBe("containment-unavailable");
    // The stream closed properly rather than stopping.
    const events = readTurnEvents(body.turnId, -1, configDir);
    expect(events.ok).toBe(true);
    if (!events.ok) {
      return;
    }
    expect(events.value.map((e: StreamEvent) => e.kind).at(-1)).toBe("turn.finished");
    expect(events.value.at(-1)?.terminal).toBe(true);

    // NOT asserted here: assistant text. `makeProvider` falls closed to the
    // offline `FakeProvider` for a config directory with no saved provider and
    // no API key — which is the correct production path and produces no deltas,
    // so demanding one here would demand a network call. The text half is
    // asserted in the next test, through the same real listener with the
    // provider — and only the provider — replaced.
  }, 30_000);

  test("assistant text reaches both views through the real listener", async () => {
    // The half the assembly above cannot prove offline. Everything is real
    // except the provider: real `startServeListener`, real socket, real token,
    // the real `createSubmitTurn` pipeline including the security scan. Only
    // the model is a stub, because the model is the one thing that cannot be
    // had without a network.
    origin = await listenWith((profile, dir) =>
      createSubmitTurn({
        profile,
        provider: new StubProvider("hello from the stub"),
        providerName: "stub-provider",
        model: "stub-model",
        dir: keryxConfigDir(dir),
        containmentAvailable: () => true,
      }),
    );

    const body = (await (await submit("say something")).json()) as { turnId: string };
    const stored = readTurnRecord(body.turnId, configDir);
    expect(stored.ok).toBe(true);
    if (!stored.ok) {
      return;
    }
    expect(stored.value.result?.outcome).toBe("completed");
    expect(stored.value.result?.text).toContain("hello from the stub");

    // And the same text is in the stream a client would attach to.
    const stream = await (
      await fetch(`${origin}/v1/turns/${body.turnId}/events`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).text();
    expect(stream).toContain("hello from the stub");
    expect(stream).toContain("assistant.delta");
  }, 30_000);

  test("a run the harness REFUSES is recorded as failed, not as completed", async () => {
    // The assertion this suite lacked, and the reason its capability test was
    // green on a turn that never ran. `runRemoteTurn` read only the run's
    // `summary` and terminated with a hardcoded `("completed", "ok")`, so on a
    // stock install — no saved provider, which is what `keryx init` leaves — the
    // harness refused at startup and the record said the turn succeeded:
    //
    //   outcome: "completed"  reasonCode: "ok"
    //   text:    "Startup blocked: missing required provider precondition(s): model."
    //
    // A record that contradicts itself in two adjacent fields, on the field a
    // client branches on.
    const base = mkdtempSync(path.join(tmpdir(), "keryx-r4c-stock-"));
    const stockDir = path.join(base, "config");
    const stockProject = path.join(base, "project");
    mkdirSync(stockDir, { recursive: true });
    mkdirSync(path.join(stockProject, ".metaproject"), { recursive: true });
    const issued = issueServeToken(stockDir);
    if (!issued.ok) {
      throw new Error("fixture could not issue a token");
    }
    registerProject(stockProject, { dir: stockDir });
    // Deliberately NO `saveShellConfig`: this is the stock install.

    const outcome = await startServeListener({
      config: defaultServeConfig(issued.record.id, { port: 0, profile: "remote-read-only" }),
      credential: { status: "ok", record: issued.record },
      dir: stockDir,
      makeSubmitTurn: assembleSubmitTurn,
    });
    if (!outcome.ok) {
      throw new Error(`listener refused to start: ${outcome.message}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${outcome.listener.port}/v1/turns`, {
        method: "POST",
        headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: "1.0.0", project: stockProject, prompt: "say something" }),
      });
      const body = (await response.json()) as { turnId: string };
      const stored = readTurnRecord(body.turnId, stockDir);
      expect(stored.ok).toBe(true);
      if (!stored.ok) {
        return;
      }
      expect(stored.value.result?.outcome).not.toBe("completed");
      expect(stored.value.result?.outcome).toBe("failed");
      // The reason names what to satisfy, not merely that something went wrong —
      // and it names WHICH ARM answered, which `toContain("blocker")` could not.
      //
      // That weakness is why a mislabel survived a round. `outcomeOf`'s
      // `status: "blocked"` arm was called `startup-blocked`, and a startup
      // refusal cannot reach it: `earlyTermination` emits `status: "failed"`.
      // A stock install lands here, on the FAILED arm, and both this assertion
      // and the unit test passed under a label naming the one cause that could
      // never produce it.
      expect(stored.value.result?.reasonCode).toBe("run-failed:blocker:startup");
      // And the record does not contradict itself: a result whose text says the
      // startup was blocked must not carry an outcome that says it was not.
      expect(stored.value.result?.text ?? "").toContain("blocked");
    } finally {
      await outcome.listener.drain();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  test("with the seam ABSENT, the production default is the REAL probe", async () => {
    // The assertion the bidirectional test below cannot make, and the one that
    // needed thinking about.
    //
    // That test supplies the seam in both directions, so it proves the parameter
    // is threaded and nothing about what is behind it: replacing the production
    // default with the buggy `() => false` — the previous round's blocker,
    // restored — left 947 tests green.
    //
    // Deriving the expectation from `detectSandboxLauncher()` does not fix that.
    // On a host with no launcher the real probe returns false, and so does the
    // hardcoded bug; the two are behaviourally identical and no assertion can
    // separate them. That is the same trap as "never supplied" versus "supplied
    // and reporting false", one level along.
    //
    // So the test moves what the DETECTOR sees. `detectSandboxLauncher` scans
    // `PATH` for `bwrap`; planting an executable of that name and prepending its
    // directory makes the real probe report true on a host where it otherwise
    // reports false. A hardcoded `false` then differs, and the mutation goes red
    // on any Linux host regardless of what is installed on it.
    //
    // Linux only, stated rather than skipped silently: on macOS the probe looks
    // for `/usr/bin/sandbox-exec`, which a test may not create.
    if (process.platform !== "linux") {
      return;
    }
    const bin = mkdtempSync(path.join(tmpdir(), "keryx-fake-bwrap-"));
    writeFileSync(path.join(bin, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${realPath ?? ""}`;
    try {
      // The premise: with the plant on PATH the real detector now says yes.
      expect(detectSandboxLauncher().available).toBe(true);

      origin = await listen("remote-restricted");
      const body = (await (await submit("say something")).json()) as { turnId: string };
      const stored = readTurnRecord(body.turnId, configDir);
      expect(stored.ok).toBe(true);
      if (!stored.ok) {
        return;
      }
      // Past the gate, because the production default consulted the detector.
      // A hardcoded `false` refuses here; so does an omitted field.
      expect(stored.value.result?.reasonCode).not.toBe("containment-unavailable");
      expect(stored.value.result?.outcome).not.toBe("refused");
    } finally {
      if (realPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = realPath;
      }
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);

  test("the production assembly CONSULTS the launcher probe, in both directions", async () => {
    // The guard for the second blocker, and it has to be bidirectional. The
    // defect was that `assembleSubmitTurn` never supplied `containmentAvailable`
    // at all, so the seam defaulted to `() => false` and every turn under the
    // shipped profile was refused. A test that only asserts the refusal cannot
    // see that: on a host without a launcher, "never supplied" and "supplied and
    // reporting false" are the same observation. Only the AVAILABLE direction
    // distinguishes them, and no single host can produce both — hence the probe
    // seam, which exists for exactly this assertion.
    //
    // `remote-restricted` throughout: the profile whose
    // `requiredControls.isolation` is `required-fail-closed`, so the gate is
    // actually reached.
    for (const available of [true, false]) {
      const base = mkdtempSync(path.join(tmpdir(), "keryx-r4c-probe-"));
      const probeDir = path.join(base, "config");
      const probeProject = path.join(base, "project");
      mkdirSync(probeDir, { recursive: true });
      mkdirSync(path.join(probeProject, ".metaproject"), { recursive: true });
      const issued = issueServeToken(probeDir);
      if (!issued.ok) {
        throw new Error("fixture could not issue a token");
      }
      registerProject(probeProject, { dir: probeDir });
      saveShellConfig({ provider: "fake", model: "fake-model" }, probeDir);

      const outcome = await startServeListener({
        config: defaultServeConfig(issued.record.id, { port: 0, profile: "remote-restricted" }),
        credential: { status: "ok", record: issued.record },
        dir: probeDir,
        makeSubmitTurn: (profile, dir) => assembleSubmitTurn(profile, dir, { containmentAvailable: () => available }),
      });
      if (!outcome.ok) {
        throw new Error(`listener refused to start: ${outcome.message}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${outcome.listener.port}/v1/turns`, {
          method: "POST",
          headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: "1.0.0", project: probeProject, prompt: "say something" }),
        });
        const body = (await response.json()) as { turnId: string };
        const stored = readTurnRecord(body.turnId, probeDir);
        expect({ available, ok: stored.ok }).toEqual({ available, ok: true });
        if (!stored.ok) {
          continue;
        }
        // The property is about the GATE, not about whether the provider can
        // answer: with the probe reporting available the turn must get PAST
        // containment (and then fail on the offline provider, which is a
        // different reason), and with it reporting unavailable it must be
        // refused for containment specifically.
        expect({ available, refusedForContainment: stored.value.result?.reasonCode === "containment-unavailable" }).toEqual(
          { available, refusedForContainment: !available },
        );
        expect({ available, outcome: stored.value.result?.outcome }).toEqual({
          available,
          outcome: available ? "failed" : "refused",
        });
      } finally {
        await outcome.listener.drain();
        rmSync(base, { recursive: true, force: true });
      }
    }
  }, 60_000);

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
      // NOT `toBeDefined()`, which is satisfied by "completed" — the value this
      // assertion was rewritten to stop accepting. There is no offline
      // configuration in which the production assembly completes a turn, so the
      // honest statement is which outcomes ARE reachable.
      expect(["failed", "refused", "cancelled"]).toContain(stored.value.result?.outcome ?? "missing");
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
    // And nothing durable happened. The previous version read a constant turn id
    // no production path mints, so the assertion was unconditionally empty —
    // disabling authentication and deleting the status check left the suite
    // green while an unauthenticated submission ran a turn to completion.
    expect(listTurnIds(configDir)).toEqual([]);
  }, 30_000);
});

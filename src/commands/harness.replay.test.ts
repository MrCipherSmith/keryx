// `keryx harness replay` — fixture validation reachable from the CLI
// (flow 134, S5 / AC7).
//
// `buildReplayFixture` / `replayOffline` were called from nowhere in `src/`
// outside their own tests, so even the integrity check they DO implement was
// unavailable. These tests drive the command the way the CLI does and pin both
// halves of AC7: a fixture built from a recorded run validates, and a tampered
// fixture reports a typed mismatch that names the diverging field.
//
// Scope note, deliberately pinned by the last test: this is `validate-log`. It
// answers "does this fixture still describe the run it was built from", not
// "would this run produce the same result today". The second is
// `simulate-recorded-results`, which Release 0 does not implement, and
// overclaiming it is exactly what the README audit caught.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { harnessCommand } from "./harness";
import { toRunRecord } from "../harness/replay/replay";
import type { HarnessRunRecord, ReplayFixture } from "../harness/replay/replay";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../harness/provider/fake-provider";
import type { NormalizedRequest, ProviderPort } from "../harness/provider/types";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolExecutorPort, ToolInvocation } from "../harness/tool/types";
import { runOffline } from "../harness/run/run";
import type { HarnessConfig } from "../harness/config";
import type { HarnessRunInput } from "../harness/types";

let workDir: string;
let logged: string[];
let errored: string[];
let restore: () => void;

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function writeRecord(overrides?: Partial<HarnessRunRecord>): string {
  const record: HarnessRunRecord = {
    schemaVersion: 1,
    runId: "run-fixture-1",
    status: "completed",
    recordedAt: "2026-01-01T00:00:00.000Z",
    sessionManifestHash: hash("a"),
    eventLogHash: hash("b"),
    toolRegistryHash: hash("c"),
    transcriptHash: hash("d"),
    expectedStateHash: hash("e"),
    ...overrides,
  };
  const file = path.join(workDir, "run-record.json");
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/** Deterministic deps so fixture/mismatch ids are stable across runs. */
function testDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return { clock: () => "2026-01-01T00:00:00.000Z", idSeq: () => `id-${counter++}` };
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "keryx-replay-"));
  logged = [];
  errored = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errored.push(args.map(String).join(" "));
  };
  restore = () => {
    console.log = originalLog;
    console.error = originalError;
  };
  process.exitCode = 0;
});

afterEach(() => {
  restore();
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("keryx harness replay (flow 134, S5)", () => {
  test("a fixture built from a recorded run validates", async () => {
    const record = writeRecord();

    await harnessCommand(["replay", "--record", record], testDeps());

    expect(process.exitCode).toBe(0);
    expect(logged.join("\n")).toContain("Replay OK (validate-log)");
    expect(logged.join("\n")).toContain("run-fixture-1");
  });

  test("--write-fixture persists a fixture that validates on a later invocation", async () => {
    const record = writeRecord();
    const fixturePath = path.join(workDir, "fixture.json");

    await harnessCommand(["replay", "--record", record, "--write-fixture", fixturePath], testDeps());
    const written = JSON.parse(readFileSync(fixturePath, "utf8")) as ReplayFixture;
    expect(written.mode).toBe("validate-log");
    expect(written.noSideEffects).toBe(true);

    logged = [];
    await harnessCommand(["replay", "--record", record, "--fixture", fixturePath], testDeps());

    expect(process.exitCode).toBe(0);
    expect(logged.join("\n")).toContain("Replay OK");
  });

  test("a tampered fixture reports a typed mismatch naming the diverging field", async () => {
    const record = writeRecord();
    const fixturePath = path.join(workDir, "fixture.json");
    await harnessCommand(["replay", "--record", record, "--write-fixture", fixturePath], testDeps());

    const tampered = JSON.parse(readFileSync(fixturePath, "utf8")) as ReplayFixture;
    tampered.transcriptHash = hash("f");
    writeFileSync(fixturePath, JSON.stringify(tampered, null, 2));

    logged = [];
    errored = [];
    await harnessCommand(["replay", "--record", record, "--fixture", fixturePath, "--json"], testDeps());

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(logged.join("\n")) as {
      ok: boolean;
      mismatch: { kind: string; detail: string; expectedHash: string; actualHash: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.mismatch.kind).toBe("provider-transcript");
    expect(payload.mismatch.detail).toContain("transcriptHash");
    expect(payload.mismatch.expectedHash).toBe(hash("f"));
    expect(payload.mismatch.actualHash).toBe(hash("d"));
  });

  test("the first divergence in check order wins, so the reported field is not arbitrary", async () => {
    const record = writeRecord();
    const fixturePath = path.join(workDir, "fixture.json");
    await harnessCommand(["replay", "--record", record, "--write-fixture", fixturePath], testDeps());

    const tampered = JSON.parse(readFileSync(fixturePath, "utf8")) as ReplayFixture;
    tampered.sessionManifestHash = hash("f");
    tampered.transcriptHash = hash("f");
    writeFileSync(fixturePath, JSON.stringify(tampered, null, 2));

    logged = [];
    await harnessCommand(["replay", "--record", record, "--fixture", fixturePath, "--json"], testDeps());

    const payload = JSON.parse(logged.join("\n")) as { mismatch: { detail: string } };
    expect(payload.mismatch.detail).toContain("sessionManifestHash");
  });

  test("a record that is not a run record is refused rather than half-read", async () => {
    const file = path.join(workDir, "not-a-record.json");
    writeFileSync(file, JSON.stringify({ hello: "world" }));

    await harnessCommand(["replay", "--record", file], testDeps());

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("is not a harness run record");
  });

  test("a missing --record prints usage", async () => {
    await harnessCommand(["replay"], testDeps());

    expect(process.exitCode).toBe(1);
    expect(logged.join("\n")).toContain("keryx harness replay --record");
  });

  test("an unreadable record file is reported by path, not thrown", async () => {
    await harnessCommand(["replay", "--record", path.join(workDir, "absent.json")], testDeps());

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Cannot read run record");
  });

  test("a record written from a real run loop is the record the command reads back", async () => {
    // The end-to-end link AC7 is really about: what `runOffline` produces, via
    // `toRunRecord`, is exactly what `keryx harness replay` accepts. Written
    // here rather than by driving `harness run --record`, because the CLI's
    // "fake" provider has no transcript wired in and never reaches a completed
    // run — a limitation of that path, not of the record format.
    const request: NormalizedRequest = {
      providerId: "fake-provider",
      modelId: "fixture-model",
      systemInstruction: "fixture system instruction",
      messages: [{ role: "user", content: "fixture prompt" }],
      budget: { maxOutputTokens: 1000, runReservation: 1000 },
      stream: true,
      requestId: "req-replay-record",
      parentRunId: "run-fixture",
    };
    const transcript: FakeProviderTranscript = {
      schemaVersion: 1,
      transcriptId: "t-replay-record",
      providerId: "fake-provider",
      providerRevision: "fake-1.0.0",
      requestHash: requestHashOf(request),
      events: [
        { sequence: 0, kind: "text_delta", payload: { text: "done" } },
        { sequence: 1, kind: "finish", payload: {} },
      ],
    };
    const fake = new FakeProvider([transcript]);
    const provider: ProviderPort = {
      describe: () => fake.describe(),
      stream: (_request, opts) => fake.stream(request, opts),
    };
    const denying: ToolExecutorPort = {
      invoke: async (invocation: ToolInvocation) => {
        throw new Error(`no executor: ${invocation.call.toolName}`);
      },
    };
    const input: HarnessRunInput = {
      schemaVersion: 1,
      request: "fixture prompt",
      projectRoot: workDir,
      role: "build",
      policy: "read-only-review",
      budget: { maxSeconds: 60, maxToolCalls: 5, maxRetries: 1 },
      provider: "fake-provider",
      model: "fixture-model",
      credentialRef: "fake-local",
    };
    const config: HarnessConfig = {
      schemaVersion: 1,
      enabled: true,
      defaultRole: "build",
      defaultProvider: "fake-provider",
      defaultModel: "fixture-model",
      policyProfile: "read-only-review",
      limits: {
        maxRunSeconds: 300,
        maxConcurrentChildren: 1,
        maxToolOutputBytes: 65_536,
        maxRetries: 1,
      },
    };
    let counter = 0;
    const result = await runOffline(input, config, {
      provider,
      toolRegistry: new ToolRegistry(),
      toolExecutor: denying,
      policyProfile: resolveLocalProfile("read-only-review"),
      clock: () => "2026-01-01T00:00:00.000Z",
      idSeq: () => `id-${counter++}`,
      interactive: false,
    });

    const file = path.join(workDir, "real-run-record.json");
    writeFileSync(
      file,
      JSON.stringify(
        toRunRecord(result, {
          runId: result.output.runId,
          status: result.output.status,
          recordedAt: result.output.startedAt,
        }),
        null,
        2,
      ),
    );

    await harnessCommand(["replay", "--record", file, "--json"], testDeps());

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(logged.join("\n")) as { ok: boolean; runId: string };
    expect(payload.ok).toBe(true);
    expect(payload.runId).toBe(result.output.runId);
  });

  test("the reported mode is validate-log, never a claim of re-execution", async () => {
    const record = writeRecord();

    await harnessCommand(["replay", "--record", record, "--json"], testDeps());

    const payload = JSON.parse(logged.join("\n")) as { mode: string; fixtureSource: string };
    expect(payload.mode).toBe("validate-log");
    expect(payload.fixtureSource).toBe("built-from-record");
  });
});

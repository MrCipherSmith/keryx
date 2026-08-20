// Tests for the external agent version probe (flow 176, T15).
//
// The spawn is injected, so nothing here starts a real process — and in
// particular nothing here can accidentally run a vendor CLI in a mode that
// spends the operator's subscription. The assertion that matters most is the
// dullest one: the argv is exactly `[binary, ...detect]`, i.e. `--version` and
// no prompt.
import { describe, expect, test } from "bun:test";
import { createVersionProbe, type ProbeSpawnLike } from "./external-agent-probe";
import { EXTERNAL_AGENTS } from "./external/registry";

/** A stream that yields one chunk then closes. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

interface FakeProbeSpawn {
  readonly impl: ProbeSpawnLike;
  readonly calls: Array<readonly string[]>;
  kills(): number;
}

function fakeSpawn(
  options: { stdout?: string; stderr?: string; exitCode?: number; hangs?: boolean; throws?: boolean } = {},
): FakeProbeSpawn {
  const calls: Array<readonly string[]> = [];
  let kills = 0;
  const impl: ProbeSpawnLike = (argv) => {
    calls.push(argv);
    if (options.throws === true) throw new Error("spawn ENOENT");
    return {
      stdout: streamOf(options.stdout ?? ""),
      stderr: streamOf(options.stderr ?? ""),
      exited: options.hangs === true ? new Promise<number>(() => undefined) : Promise.resolve(options.exitCode ?? 0),
      kill(): void {
        kills += 1;
      },
    };
  };
  return { impl, calls, kills: () => kills };
}

describe("the probe", () => {
  test("runs exactly the entry's detect argv — no prompt, no quota", async () => {
    const spawn = fakeSpawn({ stdout: "codex-cli 0.200.0\n" });
    const probe = createVersionProbe(spawn.impl);
    for (const entry of EXTERNAL_AGENTS) {
      await probe(entry.binary, entry.detect);
    }
    expect(spawn.calls).toEqual(EXTERNAL_AGENTS.map((entry) => [entry.binary, ...entry.detect]));
    for (const argv of spawn.calls) {
      expect(argv).toEqual([argv[0] ?? "", "--version"]);
    }
  });

  test("a spawn that throws is a missing binary, not a crash", async () => {
    const probe = createVersionProbe(fakeSpawn({ throws: true }).impl);
    expect(await probe("codex", ["--version"])).toEqual({ binaryFound: false });
  });

  test("combines stdout and stderr, because the two CLIs disagree on where a banner goes", async () => {
    const probe = createVersionProbe(fakeSpawn({ stdout: "out-banner", stderr: "err-banner" }).impl);
    const outcome = await probe("codex", ["--version"]);
    expect(outcome.binaryFound).toBe(true);
    expect(outcome.detectOutput).toContain("out-banner");
    expect(outcome.detectOutput).toContain("err-banner");
  });

  test("a non-zero exit still proves the binary exists", async () => {
    const probe = createVersionProbe(fakeSpawn({ stdout: "usage: codex", exitCode: 2 }).impl);
    const outcome = await probe("codex", ["--version"]);
    expect(outcome.binaryFound).toBe(true);
  });

  test("a hanging probe is killed and reported installed — reinstalling would be the wrong advice", async () => {
    const spawn = fakeSpawn({ hangs: true });
    const probe = createVersionProbe(spawn.impl, 20);
    const outcome = await probe("codex", ["--version"]);
    expect(outcome).toEqual({ binaryFound: true, detectOutput: "" });
    expect(spawn.kills()).toBe(1);
  });
});

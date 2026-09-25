// W5-AC3a pin: `keryx harness run|exec|extension|wave` behavior and help text
// are unchanged by the upcoming `keryx integrations` command family.
//
// Flow 307 (W5) is about to introduce `keryx integrations install|doctor|
// uninstall|matrix` as a SEPARATE command namespace. This suite pins the
// pre-existing `harness` surface (`src/commands/harness.ts`) so that landing
// `integrations` cannot accidentally:
//   (a) change the `harness --help` / unknown-subcommand usage text,
//   (b) change which subcommands `harnessCommand` actually dispatches, or
//   (c) make `harness` start routing `install`/`doctor`/`uninstall`/`matrix`
//       (those verbs belong to `keryx integrations`, never to `keryx harness`).
//
// This is a BEHAVIOR pin, not a fresh design: it asserts what `harness.ts`
// already does today (verified by reading the source alongside this file),
// not anything new. Hermetic: no network, no model, no real subprocess, no fs
// writes — every subcommand call below supplies fixed deps or otherwise stays
// on the fail-closed "no injected adapter/spec -> refuse before doing
// anything" path that the neighbouring suites already exercise.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { harnessCommand } from "./harness";
import { OPENAI_COMPAT_PROVIDERS } from "./providers";

/** Patches `console.log` to capture every call's stringified arguments (mirrors harness.test.ts). */
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

/** Patches `console.error` the same way, for the subcommands that report failures there. */
function captureConsoleError(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.error;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.error = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.error = original; } };
}

// The exact usage text `harnessCommand` prints for an unrecognized subcommand
// (its `USAGE` constant is not exported, so this string is the pin itself —
// any change to it, intentional or not, fails this test and must be reviewed).
//
// The provider list in line 1 is reconstructed from `OPENAI_COMPAT_PROVIDERS`
// (mirroring `HARNESS_PROVIDER_OPTIONS` in harness.ts) rather than hardcoded,
// so this pin tracks additions to the *provider* roster (unrelated to W5)
// without going stale, while still pinning the fixed `fake|anthropic|openai|
// gemini|ollama` core and the overall usage FORMAT byte-for-byte.
const HARNESS_PROVIDER_OPTIONS = [
  "fake",
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  ...OPENAI_COMPAT_PROVIDERS.map((provider) => provider.name),
];
const EXPECTED_USAGE = [
  `Usage: keryx harness run --provider <${HARNESS_PROVIDER_OPTIONS.join("|")}> --model <m> [--base-url <url>] "<prompt>"`,
  "       keryx harness exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess]",
  "         [--allowed-domains a,b] [--mask-env NAME@host] [--tls-terminate] [--mask-mode auto|manual|off] [--auto-mask]",
  "         -- <path> [args...]",
  "       keryx harness extension --spec <path>",
  "       keryx harness wave --spec <path>",
  "       keryx harness replay --record <path> [--fixture <path>] [--write-fixture <path>] [--json]",
].join("\n");

describe("W5-AC3a — harness --help / unknown-subcommand usage text is pinned", () => {
  test("`harness --help` prints the pinned usage text verbatim", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["--help"], { env: {} });
    } finally {
      restore();
    }
    expect(logs).toEqual([EXPECTED_USAGE]);
  });

  test("a bare `harness` (no subcommand) prints the same pinned usage text", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand([], { env: {} });
    } finally {
      restore();
    }
    expect(logs).toEqual([EXPECTED_USAGE]);
  });

  test("an unrecognized subcommand (e.g. `harness bogus`) prints the same pinned usage text", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["bogus"], { env: {} });
    } finally {
      restore();
    }
    expect(logs).toEqual([EXPECTED_USAGE]);
  });
});

describe("W5-AC3a — harness dispatches exactly {run, exec, extension, wave, replay} (source-text audit)", () => {
  test("the only args[0] values harnessCommand special-cases are exec/extension/wave/replay, then run", () => {
    const source = readFileSync(path.join(import.meta.dir, "harness.ts"), "utf8");
    // Pull the harnessCommand function body out (up to its own closing
    // AC8-WRAPUP-TRIGGER-END marker) so this audit reads only the dispatch
    // function itself, not the exec/extension/wave subcommand bodies below it
    // which also happen to contain other `=== "..."` comparisons.
    const start = source.indexOf("export async function harnessCommand(");
    const end = source.indexOf("// AC8-WRAPUP-TRIGGER-END", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    const dispatchedSubcommands = [...body.matchAll(/subcommand === "([a-z]+)"/g)].map((m) => m[1]);
    expect(dispatchedSubcommands).toEqual(["exec", "extension", "wave", "replay"]);

    // "run" is not matched via `subcommand === "run"` — it is the fallthrough
    // after `if (subcommand !== "run") { console.log(USAGE); return; }`. Pin
    // that guard's presence too, so a rename of the implicit "run" path would
    // also fail this audit.
    expect(body).toContain('if (subcommand !== "run")');
  });
});

describe("W5-AC3a — harness does NOT route install/doctor/uninstall/matrix (those belong to `keryx integrations`)", () => {
  for (const verb of ["install", "doctor", "uninstall", "matrix"]) {
    test(`\`harness ${verb}\` behaves exactly like an unrecognized subcommand today`, async () => {
      const { logs, restore } = captureConsoleLog();
      try {
        await harnessCommand([verb], { env: {} });
      } finally {
        restore();
      }
      expect(logs).toEqual([EXPECTED_USAGE]);
    });
  }
});

describe("W5-AC3a — each existing harness subcommand still dispatches to its own distinct behavior", () => {
  test("`run` takes the run path: distinct structured JSON output, not the usage text", async () => {
    let counter = 0;
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "pin check"],
        {
          clock: () => "2026-01-01T00:00:00.000Z",
          idSeq: () => `id-${counter++}`,
          env: {},
          fetch: (async () => {
            throw new Error("network must not be reached by this test path");
          }) as unknown as typeof fetch,
        },
      );
    } finally {
      restore();
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1]).not.toEqual(EXPECTED_USAGE);
    const parsed = JSON.parse(logs[logs.length - 1] as string) as Record<string, unknown>;
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(Array.isArray(parsed.evidence)).toBe(true);
  });

  test("`exec` takes the exec path: a plain-text fail-closed refusal, not the usage text", async () => {
    const { logs, restore } = captureConsoleLog();
    try {
      await harnessCommand(["exec", "--", "/bin/echo", "hi"], { env: {} });
    } finally {
      restore();
    }
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toEqual(EXPECTED_USAGE);
    expect(logs[0]).toContain("--allow-real-subprocess");
  });

  test("`extension` takes the extension path: it requires --spec/deps.extensionSpec, distinct from the usage text", async () => {
    await expect(harnessCommand(["extension"], { env: {} })).rejects.toThrow(/--spec/);
  });

  test("`wave` takes the wave path: it requires --spec/deps.waveSpec, distinct from the usage text", async () => {
    await expect(harnessCommand(["wave"], { env: {} })).rejects.toThrow(/--spec/);
  });

  test("`replay` takes the replay path: an unreadable --record file reports via console.error, not the usage text", async () => {
    const { logs: outLogs, restore: restoreOut } = captureConsoleLog();
    const { logs: errLogs, restore: restoreErr } = captureConsoleError();
    const priorExitCode = process.exitCode;
    try {
      await harnessCommand(["replay", "--record", "/nonexistent/does-not-exist.json"], { env: {} });
    } finally {
      restoreOut();
      restoreErr();
      // harnessReplay sets process.exitCode = 1 on this failure path; restore
      // it so this pin test does not leak a nonzero exit code into the suite.
      process.exitCode = priorExitCode;
    }
    // No usage text on stdout, and the failure was reported on stderr instead.
    expect(outLogs).toEqual([]);
    expect(errLogs.length).toBeGreaterThan(0);
    expect(errLogs.join("\n")).toContain("Cannot read run record");
  });
});

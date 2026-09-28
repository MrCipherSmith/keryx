import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "./redact";

// S-6 (flow 355, AC2): `redactSensitiveText` now runs the entropy detector on
// every tool output. That detector runs on EVERY output before it reaches the
// model (`commands/agent.ts`'s turn loop) — a false positive there degrades
// every session — so AC2 requires a measured false-positive count on a
// fixture of 200 REALISTIC command-output shapes: `git log --oneline`,
// `git show --stat`, `bun test` summaries, `npm`/`bun install` with integrity
// hashes, `ls -la`, `docker ps`, and stack traces with hex addresses.
//
// Deterministic, not random: a seeded hex generator stands in for real
// commit SHAs / container ids / integrity payloads so the fixture is
// reproducible and git-diffable, the same discipline `security/eval`'s
// corpora already follow.

function hexOf(seed: number, len: number): string {
  let out = "";
  let x = (seed * 2654435761) >>> 0;
  while (out.length < len) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

function base64ish(seed: number, len: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let x = (seed * 40503) >>> 0;
  while (out.length < len) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

function buildFixture(): string[] {
  const outputs: string[] = [];

  // 1. `git log --oneline` — 40 lines, one commit per output.
  const subjects = [
    "docs(requirements): record status after the flow",
    "fix(provider): shared stream contract, error boundary",
    "feat(cli): doctor, did-you-mean, mcp list exit codes",
    "fix(shell): review r1 lease/bus finally, wrap-up abort",
    "docs(requirements): audit remediation packages",
    "feat(api): add endpoint for api-gateway integration",
    "chore(deps): bump build toolchain to the next release",
    "test(harness): cover the sequential tool loop boundary",
  ];
  for (let i = 0; i < 40; i += 1) {
    const sha7 = hexOf(i, 7);
    outputs.push(`${sha7} ${subjects[i % subjects.length]} (#${700 + i})`);
  }

  // 2. `git show --stat` — 30 multi-line outputs.
  for (let i = 0; i < 30; i += 1) {
    const sha40 = hexOf(1000 + i, 40);
    outputs.push(
      [
        `commit ${sha40}`,
        `Author: Jane Doe <jane.doe+ci@example.com>`,
        `Date:   Mon Sep 28 0${i % 10}:00:00 2026 +0000`,
        "",
        `    fix(security): audit remediation ${i} — depth entropy`,
        "",
        ` src/security/detect/entropy.ts | 12 +++++++-----`,
        ` src/security/redact.ts         |  3 ++-`,
        ` 2 files changed, 10 insertions(+), 5 deletions(-)`,
      ].join("\n"),
    );
  }

  // 3. `bun test` summaries — 30 outputs.
  for (let i = 0; i < 30; i += 1) {
    const files = 3 + (i % 8);
    const passed = 100 + i * 7;
    outputs.push(
      [
        "bun test v1.4.2 (744846f84)",
        "",
        ` ${passed} pass`,
        " 0 fail",
        ` ${passed + 12} expect() calls`,
        `Ran ${passed} tests across ${files} files. [${(1.2 + i * 0.03).toFixed(2)}s]`,
      ].join("\n"),
    );
  }

  // 4. `npm`/`bun install` with integrity hashes — 40 outputs.
  const packages = ["lodash", "react", "typescript", "zod", "commander", "chalk", "yargs", "picocolors"];
  for (let i = 0; i < 40; i += 1) {
    const pkg = packages[i % packages.length];
    const version = `${1 + (i % 5)}.${i % 10}.${i % 3}`;
    const integrity = `sha512-${base64ish(i, 64)}==`;
    outputs.push(
      [
        `+ ${pkg}@${version}`,
        `resolved "https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz", integrity ${integrity}`,
        `added ${1 + (i % 4)} package(s) in ${300 + i * 11}ms`,
      ].join("\n"),
    );
  }

  // 5. `ls -la` — 30 outputs.
  const names = ["index.ts", "README.md", "package.json", "src", "node_modules", "dist", "script.sh", ".gitignore"];
  for (let i = 0; i < 30; i += 1) {
    const lines = [`total ${16 + i}`];
    for (let j = 0; j < 6; j += 1) {
      const isDir = j % 3 === 0;
      const perms = isDir ? "drwxr-xr-x" : j % 2 === 0 ? "-rwxr-xr-x" : "-rw-r--r--";
      lines.push(
        `${perms}  ${1 + j} user  group  ${1024 * (j + 1)} Sep 28 ${String(10 + (i % 12)).padStart(2, "0")}:0${j} ${names[(i + j) % names.length]}`,
      );
    }
    outputs.push(lines.join("\n"));
  }

  // 6. `docker ps` — 15 outputs.
  for (let i = 0; i < 15; i += 1) {
    const id = hexOf(2000 + i, 12);
    outputs.push(
      [
        "CONTAINER ID   IMAGE            COMMAND                  CREATED        STATUS        PORTS                    NAMES",
        `${id}   redis:7-alpine   "docker-entrypoint.s…"   2 hours ago    Up 2 hours    0.0.0.0:${6379 + i}->6379/tcp   my-redis-${i}`,
      ].join("\n"),
    );
  }

  // 7. stack traces with hex addresses — 15 outputs.
  for (let i = 0; i < 15; i += 1) {
    const addr = `0x${hexOf(3000 + i, 12)}`;
    outputs.push(
      [
        `Segmentation fault at address ${addr}`,
        `  at Object.<anonymous> (/app/src/index.js:${40 + i}:15)`,
        "  at Module._compile (node:internal/modules/cjs/loader:1105:14)",
        `  at Module.load (node:internal/modules/cjs/loader:${1200 + i}:32)`,
      ].join("\n"),
    );
  }

  return outputs;
}

describe("S-6 (flow 355, AC2): false-positive fixture over 200 realistic tool outputs", () => {
  const fixture = buildFixture();

  test("the fixture has exactly 200 realistic outputs", () => {
    expect(fixture.length).toBe(200);
  });

  test("the entropy detector's false-positive count on this fixture is 0", () => {
    const falsePositives = fixture
      .map((output, i) => ({ i, redacted: redactSensitiveText(output) }))
      .filter(({ redacted }) => redacted.includes("[REDACTED:entropy]"));

    // Recorded for the flow journal / AC report, not just asserted: a failure
    // here prints WHICH sample regressed, not just that one did.
    if (falsePositives.length > 0) {
      console.log("entropy false positives:", falsePositives.map((f) => f.i));
    }
    expect(falsePositives.length).toBe(0);
  });
});

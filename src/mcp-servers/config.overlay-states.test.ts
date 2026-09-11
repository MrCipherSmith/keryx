// `readOverlay`, once per STATE the overlay file can be in.
//
// The second structural test, and it exists for a measured reason. The
// null-prototype fix went onto the one line the report pointed at — the
// success path — and not onto the four sibling `return` statements in the
// same twenty-five-line function. One of those four fires when there is NO
// OVERLAY FILE AT ALL, which is the default state of every fresh install.
//
// The consequence, observed through the real CLI: with six servers marked
// `"enabled": false` in the config and no overlay file, four of them were
// listed as enabled and dialled, because `overrides[name]` resolved through
// `Object.prototype` for names like `toString`, `constructor` and
// `hasOwnProperty`. `enabled` then became a function or an object, so
// `doctor --json` emitted `"enabled": {}` for one and dropped the field
// entirely for the others.
//
// A test that runs `disable` first — which every existing overlay test does
// — creates the file and cannot see any of it.
//
// So the unit here is the STATE, and every state gets the same assertions.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpServers } from "./config";

/** Names that resolve to something through `Object.prototype`. */
const INHERITED = ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"];

type OverlayState = {
  readonly label: string;
  readonly why: string;
  /** `undefined` = write no file at all. */
  readonly write: string | undefined;
  readonly unreadable?: boolean;
  readonly expectProblem: boolean;
};

const STATES: OverlayState[] = [
  {
    label: "absent",
    why: "the default state of every fresh install, and the one the first fix missed",
    write: undefined,
    expectProblem: false,
  },
  {
    label: "valid with overrides",
    why: "the only state the original fix covered",
    write: JSON.stringify({ overrides: { other: true } }),
    expectProblem: false,
  },
  {
    label: "valid, no `overrides` key",
    why: "a file someone created by hand or a future field added beside it",
    write: JSON.stringify({ schemaVersion: 1 }),
    expectProblem: false,
  },
  {
    label: "invalid JSON",
    why: "a broken overlay must report itself and leave the files' own `enabled` in force",
    write: "{ not json",
    expectProblem: true,
  },
  {
    label: "empty file",
    why: "a truncated write, which is not the same as an absent file",
    write: "",
    expectProblem: true,
  },
  {
    label: "unreadable",
    why: "present and inaccessible is a third thing again",
    write: JSON.stringify({ overrides: {} }),
    unreadable: true,
    expectProblem: true,
  },
  {
    label: "overrides is not an object",
    why: "the key exists and holds the wrong shape",
    write: JSON.stringify({ overrides: "nope" }),
    expectProblem: false,
  },
];

function workspace(state: OverlayState): string {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-overlay-state-"));
  const configDir = path.join(base, "config");
  mkdirSync(configDir, { recursive: true });

  // Every server is DISABLED in the file. Any that comes back enabled did so
  // because the overlay lookup found something it should not have.
  const servers: Record<string, unknown> = {};
  for (const name of INHERITED) servers[name] = { command: "x", enabled: false };
  servers.plain = { command: "x", enabled: false };
  writeFileSync(
    path.join(configDir, "mcp-servers.json"),
    JSON.stringify({ schemaVersion: 1, servers }),
  );

  if (state.write !== undefined) {
    const overlay = path.join(configDir, "mcp-servers-disabled.json");
    writeFileSync(overlay, state.write);
    if (state.unreadable === true && process.platform !== "win32") chmodSync(overlay, 0o000);
  }
  return configDir;
}

describe("readOverlay behaves the same in every state the file can be in", () => {
  for (const state of STATES) {
    describe(`${state.label} — ${state.why}`, () => {
      test("a server disabled in the config stays disabled", () => {
        const configDir = workspace(state);
        const loaded = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: {} });

        expect(loaded.servers.length).toBeGreaterThan(0);
        for (const server of loaded.servers) {
          expect({ name: server.name, enabled: server.enabled }).toEqual({
            name: server.name,
            enabled: false,
          });
        }
      });

      test("`enabled` is a real boolean, so the report contract holds", () => {
        // It became a function for `toString` and an object for
        // `__proto__`; `JSON.stringify` then dropped the field or emitted
        // `{}`, which is a broken `doctor --json` payload.
        const configDir = workspace(state);
        const loaded = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: {} });

        for (const server of loaded.servers) {
          expect({ name: server.name, type: typeof server.enabled }).toEqual({
            name: server.name,
            type: "boolean",
          });
        }
        // And it survives a round trip, which is what the report does.
        const round = JSON.parse(JSON.stringify(loaded.servers)) as Array<{ name: string; enabled?: unknown }>;
        for (const server of round) {
          expect({ name: server.name, present: "enabled" in server }).toEqual({
            name: server.name,
            present: true,
          });
        }
      });

      test(`a problem is ${state.expectProblem ? "reported" : "not invented"}`, () => {
        const configDir = workspace(state);
        const loaded = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: {} });
        const overlayProblems = loaded.problems.filter((p) => p.file.includes("disabled"));
        expect(overlayProblems.length > 0).toBe(state.expectProblem);
      });
    });
  }

  test("an override in a VALID overlay still wins — the states above are not vacuous", () => {
    // If the overlay were being ignored entirely, every assertion above
    // would pass for the wrong reason.
    const base = mkdtempSync(path.join(tmpdir(), "keryx-overlay-live-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      JSON.stringify({ schemaVersion: 1, servers: { toString: { command: "x", enabled: false } } }),
    );
    writeFileSync(
      path.join(configDir, "mcp-servers-disabled.json"),
      JSON.stringify({ overrides: { toString: true } }),
    );

    const loaded = loadMcpServers({ cwd: configDir, gitRoot: configDir, configDir, env: {} });
    expect(loaded.servers[0]?.enabled).toBe(true);
  });

  test("every state the function can return from is represented", () => {
    // `readOverlay` has five returns: absent, unreadable, no-`overrides`,
    // valid, and the catch. The first fix touched one of them.
    expect(STATES.length).toBeGreaterThanOrEqual(5);
    expect(STATES.some((s) => s.write === undefined)).toBe(true);
    expect(STATES.some((s) => s.unreadable === true)).toBe(true);
    expect(STATES.some((s) => s.write === "{ not json")).toBe(true);
  });
});

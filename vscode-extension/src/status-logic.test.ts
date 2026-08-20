import { expect, test } from "bun:test";
import {
  initPromptMessage,
  interpretStatus,
  shouldPromptInit,
  shouldRevealAfterInit,
} from "./status-logic";

// AC1: `keryx status`'s 3-state result correctly drives the init-prompt flow
// (not-initialized and incomplete both prompt; ready does not) — verified by
// unit test against a mocked shell-out (here: raw stdout strings, exactly
// what `runKeryx` would hand `interpretStatus`).

test("AC1: interpretStatus recognises 'Metaproject: not initialized'", () => {
  expect(interpretStatus("Metaproject: not initialized\nRun: keryx init\n")).toBe("not-initialized");
});

test("AC1: interpretStatus recognises 'Metaproject: incomplete'", () => {
  expect(
    interpretStatus("Metaproject: incomplete\nMissing: .metaproject/metaproject.json\n"),
  ).toBe("incomplete");
});

test("AC1: interpretStatus recognises 'Metaproject: ready'", () => {
  expect(interpretStatus("Metaproject: ready\nRoot: .metaproject\nModules:\n  gdgraph: enabled\n")).toBe(
    "ready",
  );
});

test("AC1: interpretStatus treats unrecognised/empty output as incomplete (safe default)", () => {
  expect(interpretStatus("")).toBe("incomplete");
  expect(interpretStatus("garbled output from a stale binary")).toBe("incomplete");
});

test("AC1: shouldPromptInit is true for not-initialized and incomplete, false for ready", () => {
  expect(shouldPromptInit("not-initialized")).toBe(true);
  expect(shouldPromptInit("incomplete")).toBe(true);
  expect(shouldPromptInit("ready")).toBe(false);
});

test("initPromptMessage differs between not-initialized and incomplete", () => {
  const notInit = initPromptMessage("not-initialized");
  const incomplete = initPromptMessage("incomplete");
  expect(notInit).not.toBe(incomplete);
  expect(notInit).toContain("keryx init");
  expect(incomplete).toContain("keryx init");
});

// AC2: tree view auto-reveal is wired to fire within one activation cycle of
// a successful `keryx init --yes` run — verified here at the pure
// decision-logic level (the real VS Code UI reveal itself is not executable
// in this environment).

test("AC2: shouldRevealAfterInit is true only on exit 0 AND a ready status afterward", () => {
  expect(shouldRevealAfterInit(0, "ready")).toBe(true);
  expect(shouldRevealAfterInit(0, "incomplete")).toBe(false);
  expect(shouldRevealAfterInit(1, "ready")).toBe(false);
  expect(shouldRevealAfterInit(1, "incomplete")).toBe(false);
});

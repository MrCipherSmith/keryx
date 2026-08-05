// The harness content scanner (flow 134, S2 / AC3 / AC4).
//
// Before this, `runOffline` redacted every tool result through a stub that
// answered `hasSecret: false` to everything, and `commands/harness.ts` pinned
// the fail-closed `scanAvailable` signal to `true`. Two safety mechanisms, both
// unable to fire. These tests assert the behaviour that makes them real: a
// secret is detected, `available` reflects whether a scanner exists at all, and
// the whole thing degrades rather than throwing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHarnessScanner } from "./harness-scan";
import { redactForPersistence } from "../harness/evidence/redaction";

let root = "";

/** A project with `.metaproject/metaproject.json` and the security module on/off. */
function project(securityEnabled: boolean): string {
  const dir = mkdtempSync(path.join(root, "proj-"));
  mkdirSync(path.join(dir, ".metaproject"), { recursive: true });
  writeFileSync(
    path.join(dir, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: securityEnabled } } }, null, 2),
  );
  return dir;
}

// A synthetic credential in the shape the deterministic secret rules look for.
const SECRET = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-harness-scan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildHarnessScanner", () => {
  test("AC3: security disabled ⇒ available false, so the fail-closed guard can fire", async () => {
    const scanner = await buildHarnessScanner(project(false));

    expect(scanner.available).toBe(false);
    // Still callable and still permissive — the run itself is not broken.
    expect(scanner.scan(SECRET).hasSecret).toBe(false);
  });

  test("AC3: a directory with no metaproject at all ⇒ available false", async () => {
    const scanner = await buildHarnessScanner(mkdtempSync(path.join(root, "bare-")));

    expect(scanner.available).toBe(false);
  });

  test("AC3: security enabled ⇒ available true", async () => {
    const scanner = await buildHarnessScanner(project(true));

    expect(scanner.available).toBe(true);
  });

  test("AC4: a secret in tool output is detected and categorised", async () => {
    const scanner = await buildHarnessScanner(project(true));

    const result = scanner.scan(SECRET);

    expect(result.hasSecret).toBe(true);
    expect(result.category).toBe("secret");
  });

  test("AC4: clean content stays clean — no false positive on ordinary output", async () => {
    const scanner = await buildHarnessScanner(project(true));

    expect(scanner.scan("ok\n3 files changed\n").hasSecret).toBe(false);
  });

  test("empty content is clean without consulting a detector", async () => {
    const scanner = await buildHarnessScanner(project(true));

    expect(scanner.scan("").hasSecret).toBe(false);
  });
});

describe("AC4: the scanner reaches redaction-before-persistence", () => {
  test("a flagged tool result is never persisted verbatim", async () => {
    const scanner = await buildHarnessScanner(project(true));

    const redaction = redactForPersistence(SECRET, { scan: scanner.scan });

    expect(redaction.blocked).toBe(false);
    if (redaction.blocked) return;
    expect(redaction.preview).not.toContain("wJalrXUtnFEMI");
    expect(redaction.preview).toContain("[redacted:secret]");
    expect(redaction.provenance.redaction).toBe("full");
  });

  test("with the old permissive stub the same content would have been written verbatim", () => {
    // Not a test of production code — it pins why this work was needed, so a
    // future revert of the seam fails something.
    const stub = () => ({ hasSecret: false }) as const;

    const redaction = redactForPersistence(SECRET, { scan: stub });

    expect(redaction.blocked).toBe(false);
    if (redaction.blocked) return;
    expect(redaction.preview).toContain("wJalrXUtnFEMI");
  });

  test("a scanner that throws blocks persistence instead of writing unscanned bytes", () => {
    const throwing = () => {
      throw new Error("detector exploded");
    };

    // `buildHarnessScanner` catches internally; this asserts the contract the
    // catch relies on — scanFailed is terminal for persistence.
    const redaction = redactForPersistence(SECRET, {
      scan: () => {
        try {
          throwing();
          return { hasSecret: false };
        } catch {
          return { hasSecret: false, scanFailed: true };
        }
      },
    });

    expect(redaction.blocked).toBe(true);
  });
});

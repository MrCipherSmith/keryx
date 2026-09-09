/**
 * T35 independent probe F: attack the test technique disclosed in T33 concern 2
 * -- `mock.module("./config", ...)` restored in a `finally` from an EAGERLY
 * snapshotted namespace.
 *
 * The three ways this technique fails silently, each tested here:
 *   F1  the break does not actually reach an already-bound consumer (so the
 *       regression proves nothing);
 *   F2  the restore hands back the MOCK rather than the real export (the
 *       failure mode the eager snapshot exists to prevent);
 *   F3  the restore does not reach an already-bound consumer, so the break
 *       leaks into every later test in the process.
 *
 * F2 is demonstrated positively, by repeating the mistake with a LIVE namespace
 * reference and showing the leak, then showing the eager snapshot does not leak.
 *
 * Read-only on production code. Fixtures under mkdtemp, removed in finally.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import { guardOutput } from "../../../../src/security/guard";

const AWS_KEY = "AKIAABCDEFGHIJKLMNOP"; // synthetic
const SENTINEL = "T35-MOCK-SENTINEL";
const SPEC = "../../../../src/security/config";
const out: Record<string, unknown> = {};
let failures = 0;

function check(label: string, ok: boolean, detail: unknown): void {
  if (!ok) failures += 1;
  out[label] = { ok, detail };
}

async function ws(mode: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t35-mock-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "security.config.json"),
    JSON.stringify({ schemaVersion: 1, mode }),
    "utf8",
  );
  return root;
}

/**
 * The observable that distinguishes "real loader" from "broken loader" through
 * an already-bound consumer (guard.ts imported loadSecurityConfig at load time):
 *   real + enforced + planted secret -> blocked with a FINDINGS reason
 *   broken                           -> blocked with the POSTURE reason
 *   real + advisory                  -> allowed
 */
async function observe(root: string): Promise<{ allowed: boolean; reason: string }> {
  const r = await guardOutput({ cwd: root, content: `aws_key = ${AWS_KEY}`, target: "memory" });
  return { allowed: r.allowed, reason: r.reason ?? "<none>" };
}

// The eager snapshot, exactly as guard.test.ts takes it (before any mock).
const eagerSnapshot = { ...(await import(SPEC)) };
// The live namespace, i.e. the mistake the comment says cost one RED iteration.
const liveNamespace = await import(SPEC);

const enforced = await ws("enforced");
const advisory = await ws("advisory");

try {
  // --- baseline -------------------------------------------------------------
  const baseEnforced = await observe(enforced);
  const baseAdvisory = await observe(advisory);
  check("F0 baseline: enforced blocks on findings, advisory allows",
    baseEnforced.allowed === false && baseEnforced.reason.includes("secret")
      && baseAdvisory.allowed === true,
    { baseEnforced, baseAdvisory });

  // --- F1: the break reaches an already-bound consumer ----------------------
  mock.module(SPEC, () => ({ ...eagerSnapshot, loadSecurityConfig: () => Promise.reject(new Error(SENTINEL)) }));
  const broken = await observe(enforced);
  const brokenAdvisory = await observe(advisory);
  check("F1 the break reaches guard.ts's already-bound import",
    broken.allowed === false && broken.reason.includes("posture unavailable"), broken);
  check("F1 the break is mode-independent (advisory also refuses, posture unknown)",
    brokenAdvisory.allowed === false && brokenAdvisory.reason.includes("posture unavailable"), brokenAdvisory);

  // --- F2a: restoring from the LIVE namespace (the documented mistake) ------
  mock.module(SPEC, () => ({ ...liveNamespace }));
  const afterLiveRestore = await observe(advisory);
  check("F2a restoring from a LIVE namespace leaks the mock (mistake reproduced)",
    afterLiveRestore.allowed === false && afterLiveRestore.reason.includes("posture unavailable"),
    afterLiveRestore);

  // --- F2b: restoring from the EAGER snapshot (the technique under review) --
  mock.module(SPEC, () => ({ ...eagerSnapshot }));
  const afterEagerRestore = await observe(advisory);
  const afterEagerEnforced = await observe(enforced);
  check("F2b restoring from the EAGER snapshot restores the real loader",
    afterEagerRestore.allowed === true
      && afterEagerEnforced.allowed === false
      && afterEagerEnforced.reason.includes("secret"),
    { afterEagerRestore, afterEagerEnforced });

  // --- F3: a fresh import after restore also sees the real export -----------
  const fresh = await import(SPEC);
  const cfg = await fresh.loadSecurityConfig(enforced);
  check("F3 a fresh import after restore sees the real loadSecurityConfig",
    cfg.mode === "enforced", cfg.mode);

  // --- F4: the finally still restores when the body throws ------------------
  let restoredAfterThrow = false;
  try {
    mock.module(SPEC, () => ({ ...eagerSnapshot, loadSecurityConfig: () => Promise.reject(new Error(SENTINEL)) }));
    throw new Error("simulated assertion failure inside the test body");
  } catch {
    // swallowed, standing in for bun-test's own failure handling
  } finally {
    mock.module(SPEC, () => ({ ...eagerSnapshot }));
    restoredAfterThrow = (await observe(advisory)).allowed === true;
  }
  check("F4 a throwing body still leaves the real loader in place", restoredAfterThrow, restoredAfterThrow);

  // --- F5: no sentinel escapes into any observable string -------------------
  check("F5 the sentinel never reaches a reason string",
    !JSON.stringify(out).includes(SENTINEL), "<checked>");
} finally {
  mock.module(SPEC, () => ({ ...eagerSnapshot }));
  await rm(enforced, { recursive: true, force: true });
  await rm(advisory, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ probe: "T35-F mock.module restoration", out, failures }, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nT35-F: ALL CHECKS OK\n" : `\nT35-F: ${failures} CHECK(S) FAILED\n`);
process.exit(0);

// T30 independent probe (review of T27 / src/security/guard.ts).
// Not part of the implementer's guard.test.ts suite -- written fresh by the
// reviewer to attack scenarios the shipped tests do not cover:
//   1. formatGuardWarning with a finding AND an incomplete gate together
//      (AC6/AFC-17: violation + incomplete visible at once) -- the shipped
//      suite only exercises incomplete-with-zero-findings.
//   2. formatGuardWarning still returns null for a genuine zero-finding pass.
//   3. guardOutput/securityFlowGate in enforced mode, exercised end to end
//      through a real HMAC-key-unreadable fixture (independently built, not
//      reusing the test file's workspace helper).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatGuardWarning,
  guardOutput,
  securityFlowGate,
} from "../../../../src/security/guard";
import { keyDir } from "../../../../src/security/redact";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.log(`FAIL: ${label}${detail ? " -- " + detail : ""}`);
  }
}

async function makeWorkspace(opts: { security?: boolean; mode?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "t30-guard-probe-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.security !== undefined) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: opts.security } } }),
      "utf8",
    );
  }
  if (opts.mode) {
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: opts.mode }),
      "utf8",
    );
  }
  return root;
}

async function main() {
  // --- Probe A: AC6 -- finding AND incomplete gate visible together ---
  // formatGuardWarning is a pure function; construct the decision directly so
  // the probe is independent of which detector produces `incomplete`.
  {
    const decision = {
      gate: "incomplete" as const,
      action: "warn" as const,
      findings: [
        { category: "secret", action: "block", detector: "rules", confidence: 1 } as any,
      ],
    };
    const msg = formatGuardWarning(decision, "memory");
    check(
      "AC6: finding+incomplete -- message is non-null",
      msg !== null,
    );
    check(
      "AC6: finding+incomplete -- gate 'incomplete' is visible",
      typeof msg === "string" && msg.includes("incomplete"),
      msg ?? "null",
    );
    check(
      "AC6: finding+incomplete -- finding category 'secret' is visible",
      typeof msg === "string" && msg.includes("secret"),
      msg ?? "null",
    );
  }

  // --- Probe B: genuine zero-finding PASS still returns null (no regression) ---
  {
    const msg = formatGuardWarning({ gate: "pass", action: "allow", findings: [] });
    check("AC6 sibling: genuine pass + 0 findings -> null (unchanged)", msg === null, String(msg));
  }

  // --- Probe C: end-to-end incomplete evidence through guardOutput, enforced ---
  {
    const root = await makeWorkspace({ security: true, mode: "enforced" });
    try {
      // Same technique as guard.test.ts (HMAC key path replaced by a directory
      // so the key read fails) but built independently to confirm the fixture
      // itself, not just the assertions, is correct.
      await mkdir(path.join(keyDir(root), "hmac.key"), { recursive: true });
      const result = await guardOutput({ cwd: root, content: "ordinary text", target: "memory" });
      check("enforced: incomplete engine evidence -> allowed:false", result.allowed === false, JSON.stringify(result));
      check("enforced: decision.gate is 'incomplete'", result.decision.gate === "incomplete");
      check(
        "enforced: reason is masked (no cwd/path leak)",
        typeof result.reason === "string" && !result.reason.includes(root),
        result.reason,
      );
      check(
        "enforced: reason names 'incomplete', not a raw error string",
        typeof result.reason === "string" && result.reason.includes("incomplete"),
        result.reason,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Probe D: advisory mode keeps allowed:true but truthful incomplete diag ---
  {
    const root = await makeWorkspace({ security: true, mode: "advisory" });
    try {
      await mkdir(path.join(keyDir(root), "hmac.key"), { recursive: true });
      const result = await guardOutput({ cwd: root, content: "ordinary text", target: "memory" });
      check("advisory: incomplete engine evidence -> allowed:true", result.allowed === true);
      check("advisory: decision.gate is truthfully 'incomplete'", result.decision.gate === "incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

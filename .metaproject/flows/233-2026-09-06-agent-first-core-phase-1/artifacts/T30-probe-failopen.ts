// T30 independent probe: attack the residual fail-open in src/security/guard.ts.
//
// The implementer's own report discloses that guardOutput's outer try/catch
// (around loadSecurityConfig + service.check) degrades to ALLOW on ANY thrown
// error, including a loadSecurityConfig failure. This probe:
//   1. Reproduces that disclosed fail-open concretely (a corrupt config file
//      in a nominally "enforced" workspace still allows a planted secret).
//   2. Tests whether the SAME trigger (loadSecurityConfig throwing) has a
//      twin, undisclosed fail-open in securityFlowGate -- which has its own,
//      separate try/catch around the identical `loadSecurityConfig(cwd)` call
//      that returns `null` (gate omitted) rather than a blocking status.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { guardOutput, securityFlowGate } from "../../../../src/security/guard";
import { loadSecurityConfig } from "../../../../src/security/config";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.log(`FAIL: ${label}${detail ? " -- " + detail : ""}`);
  }
}
function note(label: string) {
  console.log(`NOTE: ${label}`);
}

const AWS_KEY = "AKIAABCDEFGHIJKLMNOP"; // synthetic, not a real credential

async function makeCorruptConfigWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t30-failopen-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  // A syntactically valid JSON document (`null`) that is not an object.
  // readJsonFileOr/JSON.parse succeed (no exception), so loadSecurityConfig's
  // own `pathExists`/`readJsonFileOr` guards do not catch this -- the crash
  // happens one line later, in mergeSecurityConfig(parsed), which reads
  // `parsed.policies` off a `null` value.
  await writeFile(path.join(root, ".metaproject", "security.config.json"), "null", "utf8");
  return root;
}

async function main() {
  const root = await makeCorruptConfigWorkspace();
  try {
    // Confirm the trigger in isolation first: does loadSecurityConfig really throw?
    let loadThrew = false;
    let loadErrorMessage = "";
    try {
      await loadSecurityConfig(root);
    } catch (error) {
      loadThrew = true;
      loadErrorMessage = error instanceof Error ? error.message : String(error);
    }
    check(
      "trigger confirmed: loadSecurityConfig(cwd) throws on security.config.json == 'null'",
      loadThrew,
      loadThrew ? loadErrorMessage : "did not throw",
    );
    if (!loadThrew) {
      note("Trigger not reproduced on this build -- remaining probes are not meaningful; inspect config.ts.");
      console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
      process.exit(failures === 0 ? 0 : 1);
      return;
    }

    // --- Disclosed fail-open: guardOutput degrades to ALLOW ---
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    check(
      "DISCLOSED FAIL-OPEN reproduced: guardOutput(cwd, secret) with corrupt config -> allowed:true",
      result.allowed === true,
      JSON.stringify(result),
    );
    check(
      "the planted secret is not blocked despite the workspace being nominally configured for enforced mode",
      result.decision.gate === "pass",
      JSON.stringify(result.decision),
    );

    // --- Undisclosed twin: securityFlowGate's own loadSecurityConfig catch ---
    const gate = await securityFlowGate(root);
    check(
      "TWIN PATH: securityFlowGate(cwd) under the identical corrupt-config trigger returns null (gate OMITTED)",
      gate === null,
      JSON.stringify(gate),
    );
    note(
      "flow/service.ts Gate 6 is: `if (deps.securityGate) { const security = await deps.securityGate(cwd); " +
        "if (security) { gates.push(...) } }` -- when securityFlowGate returns null, NO gate entry is pushed at " +
        "all. `gates.every((gate) => gate.status !== \"fail\")` never sees a security gate, so flow completion " +
        "proceeds with zero record that a security check was attempted and could not run. This is not " +
        "'skipped' (visible, non-blocking) or 'fail' (blocking) -- it is silent non-participation, which for " +
        "flow-completion purposes is indistinguishable from PASS. Same root trigger as the disclosed " +
        "guardOutput fail-open (loadSecurityConfig throwing), same file, not mentioned in T27's Concerns.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

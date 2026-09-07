// T30 independent probe: is guard.ts's securityFlowGate mapping exhaustive
// over SecurityGate ("pass" | "needs-approval" | "incomplete" | "fail")?
//
// Context (dispatch, not mine to fix): a separate reviewer confirmed
// src/security/service.ts's runGate folds only "fail"/"incomplete" out of the
// stored report's `gate`; a stored "needs-approval" (or a missing/unrecognized
// gate string) falls through to its `{ status: "pass" }` default. Tracked as
// T33. My question: once runGate is fixed to surface "needs-approval" (and a
// broader "incomplete") as real statuses, does guard.ts's OWN mapping in
// securityFlowGate handle them, or does guard.ts need a matching fix too?
//
// securityFlowGate's mapping (src/security/guard.ts, current):
//   const result = await createSecurityService(cwd).gate({ cwd });
//   return result.status === "fail" || result.status === "incomplete"
//     ? { status: "fail", detail }
//     : { status: "pass", detail };
//
// This is a two-value allowlist with an implicit "everything else -> pass"
// default -- the exact shape of fold that made T33 a finding one layer down.
// This probe demonstrates the propagation end-to-end with TODAY's runGate
// (via a stored latest.json with gate:"needs-approval", a real, typed
// SecurityGate value): the whole chain currently reads it as PASS.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityFlowGate } from "../../../../src/security/guard";
import { runGate } from "../../../../src/security/service";

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

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "t30-exhaustive-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: true } } }),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: "enforced" }),
      "utf8",
    );
    const artifactsDir = path.join(root, ".metaproject", "data", "security", "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    // A real, typed SecurityGate value that is neither "fail" nor "incomplete".
    await writeFile(
      path.join(artifactsDir, "latest.json"),
      JSON.stringify({ gate: "needs-approval", findings: [] }),
      "utf8",
    );

    const rawGate = await runGate({ cwd: root });
    note(`runGate({cwd}) on a stored gate:"needs-approval" report -> status:"${rawGate.status}" (today's fold; not mine to fix, tracked as T33)`);

    const flowGate = await securityFlowGate(root);
    check(
      "guard.ts securityFlowGate on the same stored report",
      flowGate !== null,
      "gate unexpectedly omitted",
    );
    if (flowGate) {
      console.log(`securityFlowGate(cwd) -> status:"${flowGate.status}" detail:${JSON.stringify(flowGate.detail)}`);
      check(
        "PROPAGATION GAP: enforced-mode flow completion currently reads a needs-approval security decision as PASS",
        flowGate.status === "pass",
        `expected pass (demonstrating the gap); got ${flowGate.status}`,
      );
    }
    note(
      "This 'pass' currently originates in runGate's fold (T33), not in securityFlowGate's own logic. But " +
        "securityFlowGate's ternary (`result.status === \"fail\" || result.status === \"incomplete\" ? fail : " +
        "pass`) is ITSELF non-exhaustive over runGate's declared return type " +
        "(`\"pass\" | \"incomplete\" | \"fail\"`) and over the full SecurityGate union " +
        "(`\"pass\" | \"needs-approval\" | \"incomplete\" | \"fail\"`, src/security/types.ts:68) that the stored " +
        "report's `gate` field is actually typed as. If T33 changes runGate to literally return " +
        "`status: \"needs-approval\"` (rather than folding it into fail/incomplete internally), this ternary's " +
        "fallback silently coerces it to \"pass\" -- guard.ts would need its own exhaustive mapping (switch/if " +
        "over every SecurityGate-derived status, unknown defaulting to fail) to not reproduce the same class of " +
        "bug one layer up the call stack.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL PROBES PASSED (gap demonstrated as expected)" : `\n${failures} PROBE(S) FAILED`);
  process.exit(0); // informational probe; exit 0 regardless -- see console output for the finding
}

main();

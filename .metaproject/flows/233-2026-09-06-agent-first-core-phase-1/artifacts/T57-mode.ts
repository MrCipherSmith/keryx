// T57 probe A (row 1) — attack the security `mode` validation boundary.
//
// Read-only against production code. Every fixture is `mkdtemp` and removed in
// `finally`. The only key-shaped string is the synthetic AWS example key the
// repository's own tests already use; it is never a real credential.
//
// Each row drives, for one `security.config.json` payload:
//   - `loadSecurityConfig`               (the loader under repair)
//   - `guardOutput`                      (the write seam, with a planted key)
//   - `securityFlowGate`                 (the flow-completion gate)
//   - `securityCommand(["check-input"])` (the REAL CLI entry point + exit code)
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSecurityConfig } from "../../../../src/security/config";
import { guardOutput, securityFlowGate } from "../../../../src/security/guard";
import { securityCommand } from "../../../../src/commands/security";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const PLANTED = "AKIAIOSFODNN7EXAMPLE";
const CONTENT = `aws_access_key_id = ${PLANTED}`;

async function ws(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t57-mode-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  if (config !== "<<ABSENT>>") {
    await writeFile(path.join(root, ".metaproject", "security.config.json"), config, "utf8");
  }
  return root;
}

// Drive the real CLI without letting its own console output interleave with the
// evidence rows. Restores everything it swaps.
async function cliExit(root: string, args: string[]): Promise<number> {
  const log = console.log;
  const err = console.error;
  const write = process.stdout.write.bind(process.stdout);
  const prev = process.exitCode;
  console.log = () => {};
  console.error = () => {};
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = () => true;
  process.exitCode = 0;
  try {
    await securityCommand(args, root);
    return (process.exitCode as number | undefined) ?? 0;
  } finally {
    process.exitCode = prev;
    console.log = log;
    console.error = err;
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

const LEAKS = [PLANTED, "JSON", "ENOENT", "Unexpected", "SyntaxError"];

const CASES: [string, string][] = [
  // --- controls: the four recognized values must be untouched ---
  ["M01 mode advisory (control, permissive)", '{"mode":"advisory"}'],
  ["M02 mode gateway (control, permissive)", '{"mode":"gateway"}'],
  ["M03 mode enforced (control, blocking)", '{"mode":"enforced"}'],
  ["M04 mode ci (control, blocking)", '{"mode":"ci"}'],
  // --- absent mode must still resolve to the permissive default ---
  ["M05 mode key ABSENT, empty object", "{}"],
  ["M06 mode key ABSENT, other keys present", '{"storeHashes":true,"rawRetention":"off"}'],
  ["M07 config file ABSENT entirely", "<<ABSENT>>"],
  // --- case ---
  ["M08 mode 'ADVISORY' (upper)", '{"mode":"ADVISORY"}'],
  ["M09 mode 'Advisory' (mixed)", '{"mode":"Advisory"}'],
  ["M10 mode 'CI' (upper)", '{"mode":"CI"}'],
  ["M11 mode 'Enforced' (mixed)", '{"mode":"Enforced"}'],
  // --- surrounding whitespace ---
  ["M12 mode 'advisory ' (trailing space)", '{"mode":"advisory "}'],
  ["M13 mode ' advisory' (leading space)", '{"mode":" advisory"}'],
  ["M14 mode 'ci\\n' (trailing newline)", '{"mode":"ci\\n"}'],
  ["M15 mode 'ci\\t' (tab)", '{"mode":"ci\\t"}'],
  ["M16 mode '\\u00a0ci' (non-breaking space)", '{"mode":"\\u00a0ci"}'],
  ["M17 mode 'ci\\u0000' (NUL suffix)", '{"mode":"ci\\u0000"}'],
  // --- non-string scalars ---
  ["M18 mode 42 (number)", '{"mode":42}'],
  ["M19 mode 0 (falsy number)", '{"mode":0}'],
  ["M20 mode true", '{"mode":true}'],
  ["M21 mode false (falsy)", '{"mode":false}'],
  ["M22 mode null (declared, not merged)", '{"mode":null}'],
  ["M23 mode '' (empty string)", '{"mode":""}'],
  // --- a recognized value nested one level deeper than expected ---
  ["M24 mode ['advisory'] (array of a recognized value)", '{"mode":["advisory"]}'],
  ["M25 mode ['enforced'] (array of a strict value)", '{"mode":["enforced"]}'],
  ["M26 mode {mode:'advisory'} (object one level deeper)", '{"mode":{"mode":"advisory"}}'],
  ["M27 mode {value:'advisory'}", '{"mode":{"value":"advisory"}}'],
  ["M28 mode {} (empty object)", '{"mode":{}}'],
  ["M29 mode [] (empty array)", '{"mode":[]}'],
  ["M30 mode nested under 'security' key (mode itself absent)", '{"security":{"mode":"advisory"}}'],
  ["M31 mode nested under 'config' key (mode itself absent)", '{"config":{"mode":"advisory"}}'],
  // --- prototype route to a permissive mode ---
  ["M32 __proto__ carrying mode advisory", '{"__proto__":{"mode":"advisory"}}'],
  ["M33 __proto__ carrying mode advisory + real mode ci", '{"__proto__":{"mode":"advisory"},"mode":"ci"}'],
  // --- near-misses an operator could plausibly type ---
  ["M34 mode 'report-only'", '{"mode":"report-only"}'],
  ["M35 mode 'enforce' (singular)", '{"mode":"enforce"}'],
  ["M36 mode 'advisory,ci'", '{"mode":"advisory,ci"}'],
];

for (const [label, config] of CASES) {
  const root = await ws(config);
  try {
    const cfg = await loadSecurityConfig(root);
    const guard = await guardOutput({ cwd: root, content: CONTENT, target: "memory" });
    const gate = await securityFlowGate(root);
    const file = path.join(root, "payload.txt");
    await writeFile(file, CONTENT, "utf8");
    const cli = await cliExit(root, ["check-input", "--file", file, "--json"]);
    const blob = JSON.stringify({ r: guard.reason ?? null, g: gate });
    out({
      label,
      loadedMode: cfg.mode,
      configUnreadable: (cfg as { configUnreadable?: boolean }).configUnreadable ?? null,
      guardAllowed: guard.allowed,
      guardGate: guard.decision.gate,
      guardReason: guard.reason ?? null,
      flowGate: gate === null ? "NULL(module disabled)" : gate,
      cliCheckInputExit: cli,
      credentialLetThrough: guard.allowed === true,
      leaky: LEAKS.some((s) => blob.includes(s)) || blob.includes(root),
    });
  } catch (e) {
    out({ label, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

out({
  label: "M99 prototype hygiene after every payload",
  protoMode: (Object.prototype as unknown as { mode?: unknown }).mode ?? null,
  protoModules: (Object.prototype as unknown as { modules?: unknown }).modules ?? null,
});

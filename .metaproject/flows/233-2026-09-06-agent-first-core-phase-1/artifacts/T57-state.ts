// T57 probe D (row 4) — the persisted posture across a broken-config window.
//
// Drives the REAL `createSecurityService(root).check()` (which is `analyze()`,
// the only `writeState` caller) and reads back `state.json` and the durable
// `incidents.jsonl` trail. Tests the implementer's argument that skipping the
// state write closes both failure directions, including the first-run case.
//
// Read-only against production code; every fixture is `mkdtemp` and removed.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecurityService } from "../../../../src/security/service";
import { readState } from "../../../../src/security/self-protect";
import { listIncidents } from "../../../../src/security/incidents";
import { loadSecurityConfig } from "../../../../src/security/config";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const CONTENT = "just some ordinary generated prose with no secret in it";

async function ws(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t57-state-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  return root;
}

async function setConfig(root: string, body: string): Promise<void> {
  await writeFile(path.join(root, ".metaproject", "security.config.json"), body, "utf8");
}

async function run(root: string): Promise<{ warnings: string[]; mode: string }> {
  const cfg = await loadSecurityConfig(root);
  // `check` -> `analyze`, which is the only caller of `writeState`.
  await createSecurityService(root).check({
    content: CONTENT,
    source: "generated",
    target: "memory",
  });
  // Re-run through `analyze` directly is not needed; warnings surface through
  // the service's own `checkWithWarnings`-style path in the CLI. What matters
  // here is the durable trail, read below.
  return { warnings: [], mode: cfg.mode };
}

async function trail(root: string) {
  const state = await readState(root);
  const incidents = await listIncidents(root);
  return {
    stateMode: state?.mode ?? "NO STATE FILE",
    incidentTypes: incidents.map((i) => i.type),
  };
}

const BROKEN: [string, string][] = [
  ["unusable payload (null)", "null"],
  ["unrecognized mode (ENFORCED)", '{"mode":"ENFORCED"}'],
];

for (const [brokenLabel, brokenBody] of BROKEN) {
  // ---- S1: repair to the SAME real mode raises nothing.
  {
    const root = await ws();
    try {
      await setConfig(root, '{"mode":"advisory"}');
      await run(root);
      const afterReal = await trail(root);
      await setConfig(root, brokenBody);
      await run(root);
      const afterBroken = await trail(root);
      await setConfig(root, '{"mode":"advisory"}');
      await run(root);
      const afterRepair = await trail(root);
      out({
        label: `S1 [${brokenLabel}] real advisory -> broken -> repair to advisory`,
        stateAfterReal: afterReal.stateMode,
        stateAfterBroken: afterBroken.stateMode,
        stateAfterRepair: afterRepair.stateMode,
        incidentsEver: afterRepair.incidentTypes,
        spuriousDowngrade: afterRepair.incidentTypes.includes("mode-downgrade"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ---- S2: a GENUINE downgrade across the broken window is still detected.
  for (const [from, to] of [
    ["gateway", "ci"],
    ["enforced", "advisory"],
    ["ci", "advisory"],
    ["gateway", "advisory"],
  ] as const) {
    const root = await ws();
    try {
      await setConfig(root, JSON.stringify({ mode: from }));
      await run(root);
      await setConfig(root, brokenBody);
      await run(root);
      const afterBroken = await trail(root);
      await setConfig(root, JSON.stringify({ mode: to }));
      await run(root);
      const after = await trail(root);
      out({
        label: `S2 [${brokenLabel}] real ${from} -> broken -> genuine downgrade to ${to}`,
        stateAfterBroken: afterBroken.stateMode,
        incidentsAfterBrokenRun: afterBroken.incidentTypes,
        incidentsAfterDowngrade: after.incidentTypes,
        genuineDowngradeDetected:
          after.incidentTypes.filter((t) => t === "mode-downgrade").length >
          afterBroken.incidentTypes.filter((t) => t === "mode-downgrade").length,
        stateAfterDowngrade: after.stateMode,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ---- S3: an UPGRADE across the broken window raises nothing.
  {
    const root = await ws();
    try {
      await setConfig(root, '{"mode":"advisory"}');
      await run(root);
      await setConfig(root, brokenBody);
      await run(root);
      await setConfig(root, '{"mode":"ci"}');
      await run(root);
      const after = await trail(root);
      out({
        label: `S3 [${brokenLabel}] real advisory -> broken -> upgrade to ci`,
        stateAfterUpgrade: after.stateMode,
        incidents: after.incidentTypes,
        spuriousIncident: after.incidentTypes.length > 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ---- S4: FIRST run already broken, no prior state, repeated broken runs.
  {
    const root = await ws();
    try {
      await setConfig(root, brokenBody);
      await run(root);
      const after1 = await trail(root);
      await run(root);
      await run(root);
      const after3 = await trail(root);
      await setConfig(root, '{"mode":"enforced"}');
      await run(root);
      const afterRepair = await trail(root);
      out({
        label: `S4 [${brokenLabel}] FIRST run already broken, no prior state`,
        stateAfterFirstBrokenRun: after1.stateMode,
        incidentsAfterFirstBrokenRun: after1.incidentTypes,
        stateAfterThreeBrokenRuns: after3.stateMode,
        incidentsAfterThreeBrokenRuns: after3.incidentTypes,
        stateAfterRepair: afterRepair.stateMode,
        incidentsAfterRepair: afterRepair.incidentTypes,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ---- S5: a policy the operator disables across the broken window is still caught.
  {
    const root = await ws();
    try {
      await setConfig(root, '{"mode":"enforced"}');
      await run(root);
      await setConfig(root, brokenBody);
      await run(root);
      await setConfig(
        root,
        JSON.stringify({ mode: "enforced", policies: { secrets: { enabled: false, action: "block" } } }),
      );
      await run(root);
      const after = await trail(root);
      out({
        label: `S5 [${brokenLabel}] policy disabled across the broken window`,
        incidents: after.incidentTypes,
        policyDisabledDetected: after.incidentTypes.includes("policy-disabled"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // ---- S6: the LIVE in-window comparison (disclosed item 4). Prior real mode
  // `gateway` is the only rank above the forced `enforced`.
  {
    const root = await ws();
    try {
      await setConfig(root, '{"mode":"gateway"}');
      await run(root);
      const before = await trail(root);
      await setConfig(root, brokenBody);
      await run(root);
      const during = await trail(root);
      await setConfig(root, '{"mode":"gateway"}');
      await run(root);
      const afterRepair = await trail(root);
      out({
        label: `S6 [${brokenLabel}] LIVE in-window comparison, prior real mode gateway`,
        incidentsBeforeBreak: before.incidentTypes,
        incidentsDuringBrokenWindow: during.incidentTypes,
        incidentsAfterRepairToSameMode: afterRepair.incidentTypes,
        durableIncidentWrittenByTheBrokenRun:
          during.incidentTypes.length > before.incidentTypes.length,
        stateAfterRepair: afterRepair.stateMode,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ---- S7: does a broken run leave the config file or any state artifact behind?
{
  const root = await ws();
  try {
    await setConfig(root, "null");
    await run(root);
    const { readdir, readFile } = await import("node:fs/promises");
    const meta = await readdir(path.join(root, ".metaproject"));
    let raw: string[] = [];
    try {
      raw = await readdir(path.join(root, ".metaproject", "data", "security", "raw"));
    } catch {
      raw = ["<no raw dir>"];
    }
    out({
      label: "S7 a broken run does not rewrite the config or synthesize state",
      configBytes: await readFile(path.join(root, ".metaproject", "security.config.json"), "utf8"),
      metaprojectDir: meta.sort(),
      securityRawDir: raw.sort(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Flow 289, AC4 — `flow ac confirm` and `flow complete` each append a
// signature (who, when, what was signed); signatures are append-only.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowService, FlowServiceDeps, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";

function fakeTracker(over: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
    ...over,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-22T10:00:00Z"),
    ...over,
  };
}

async function fresh(deps: Partial<FlowServiceDeps> = {}): Promise<FlowService> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-signatures-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService(makeDeps(deps));
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

// --- ac confirm --------------------------------------------------------------

test("AC4: `ac confirm` appends a signature naming the criterion, identity, and the checksum in force", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Signed confirm" });
  const dir = path.basename(created);
  await writeAc(dir, ["First criterion"]);
  const frozen = await service.freeze({ cwd: ROOT, id: flow.id });

  const confirmed = await service.acConfirm({
    cwd: ROOT,
    id: flow.id,
    criterion: "AC1",
    signedBy: "Aleks",
  });

  expect(confirmed.signatures).toHaveLength(1);
  const signature = confirmed.signatures?.[0];
  expect(signature?.kind).toBe("ac-confirm");
  expect(signature?.criterion).toBe("AC1");
  expect(signature?.identity).toEqual({ value: "Aleks", basis: "stated", source: "`--signed-by` flag" });
  expect(signature?.acChecksum).toBe(frozen.acChecksum);
});

test("AC4: reconfirming the same criterion appends a NEW signature; the earlier one is not replaced", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Reconfirm" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });

  const first = await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1", signedBy: "Aleks" });
  const second = await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1", signedBy: "Priya" });

  expect(second.signatures).toHaveLength(2);
  expect(second.signatures?.[0]).toEqual(first.signatures?.[0]);
  expect(second.signatures?.[1]?.identity.value).toBe("Priya");
});

test("AC4: an unknown signer resolves to basis unknown, and no value is invented", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "No signer given" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });

  const confirmed = await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });

  expect(confirmed.signatures?.[0]?.identity).toEqual({
    value: null,
    basis: "unknown",
    source: "no --signed-by flag, KERYX_ACTOR environment variable, or readable git identity",
  });
});

test("AC4: a git-derived signer is recorded with basis derived, never promoted to stated", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Derived signer" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });

  const confirmed = await service.acConfirm({
    cwd: ROOT,
    id: flow.id,
    criterion: "AC1",
    gitIdentity: "someone@example.com",
  });

  expect(confirmed.signatures?.[0]?.identity.basis).toBe("derived");
  expect(confirmed.signatures?.[0]?.identity.value).toBe("someone@example.com");
});

test("`flow ac update` clears acConfirmed but leaves signatures and the owner (and its history) untouched", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({
    cwd: ROOT,
    title: "ac update leaves owner/signatures alone",
    owner: "Aleks",
  });
  const dir = path.basename(created);
  await writeAc(dir, ["First criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.ownerSet({ cwd: ROOT, id: flow.id, owner: "Priya", reason: "handoff" });
  const confirmed = await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1", signedBy: "Priya" });

  expect(Object.keys(confirmed.acConfirmed)).toEqual(["AC1"]);
  expect(confirmed.signatures).toHaveLength(1);
  const ownerBeforeUpdate = confirmed.owner;
  const ownerHistoryBeforeUpdate = confirmed.history.filter(
    (event) => event.event === "owner-set" || event.event === "owner-changed",
  );
  expect(ownerHistoryBeforeUpdate).toHaveLength(1);

  // The AC file changes (a new criterion added), so the checksum is stale and
  // every prior confirmation is void — that is exactly what `ac update` is
  // for. What it must NOT touch is the owner, the owner's change history, or
  // the append-only signature record: those are a different kind of fact
  // (who is accountable, who signed) from "which criteria are confirmed".
  await writeAc(dir, ["First criterion", "Second criterion"]);
  const updated = await service.acUpdate({ cwd: ROOT, id: flow.id, reason: "scope grew" });

  expect(updated.acConfirmed).toEqual({}); // cleared, as documented
  expect(updated.acChecksum).not.toBe(confirmed.acChecksum); // re-sealed over the new file

  // Unaffected by the update:
  expect(updated.owner).toEqual(ownerBeforeUpdate);
  expect(updated.signatures).toEqual(confirmed.signatures);
  const ownerHistoryAfterUpdate = updated.history.filter(
    (event) => event.event === "owner-set" || event.event === "owner-changed",
  );
  expect(ownerHistoryAfterUpdate).toEqual(ownerHistoryBeforeUpdate);
});

// --- complete -----------------------------------------------------------------

/** Drive a fresh flow to a passing `complete()`. */
async function driveToPassingComplete(
  service: FlowService,
  title: string,
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title, owner: "Aleks" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  return { id: flow.id, dir };
}

test("AC4: a passing `complete` appends a completion signature with the AC checksum and the observed PR head", async () => {
  const service = await fresh();
  const { id } = await driveToPassingComplete(service, "Signed completion");

  const result = await service.complete({ cwd: ROOT, id, signedBy: "Aleks" });

  expect(result.passed).toBe(true);
  const signature = result.flow.signatures?.at(-1);
  expect(signature?.kind).toBe("complete");
  expect(signature?.identity).toEqual({ value: "Aleks", basis: "stated", source: "`--signed-by` flag" });
  expect(signature?.acChecksum).toBe(result.flow.acChecksum);
  expect(signature?.headCommit).toBe(HEAD); // captured from the fake tracker's PR head, no extra fetch
});

test("AC4: a direct-merge completion signs the merged commit as the observed head", async () => {
  const MERGED = "7b78ff14";
  const service = await fresh({
    tracker: null,
    mainMergeGate: async (_cwd, commit) =>
      commit === MERGED
        ? { status: "pass", detail: `${MERGED} is contained in origin/main` }
        : { status: "fail", detail: `${commit} is not contained in origin/main` },
  });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Merged, signed", owner: "Aleks" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: MERGED, prUrl: null });

  const result = await service.complete({ cwd: ROOT, id: flow.id, mergedCommit: MERGED, signedBy: "Aleks" });

  expect(result.passed).toBe(true);
  const signature = result.flow.signatures?.at(-1);
  expect(signature?.headCommit).toBe(MERGED);
});

test("AC4: a completion signature is appended even when no identity was available", async () => {
  const service = await fresh();
  const { id } = await driveToPassingComplete(service, "Unsigned completion");

  const result = await service.complete({ cwd: ROOT, id });

  const signature = result.flow.signatures?.at(-1);
  expect(signature?.identity.basis).toBe("unknown");
});

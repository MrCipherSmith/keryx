import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowServiceDeps } from "./types";

// `flow ac update` re-seals the checksum AND wipes every confirmation, which is
// correct when the criteria changed and destructive when only the seal is
// stale. Flow 002 is the case that forced the distinction: ten confirmations
// with dated evidence notes, against a criteria file byte-identical to its
// first commit and an `acChecksum` unchanged since that same commit. Clearing
// those to silence a mismatch would trade the evidence for a green check.
//
// So `reseal` keeps the confirmations, and pays for that with a hard gate: git
// must report the file tracked and unchanged against HEAD. These tests drive
// real `git` in a real repository, because the gate IS the git call — asserting
// it against a stub would only prove the stub.

function deps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-03T21:00:00Z"),
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function realRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-reseal-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "fixture"]);
  return root;
}

// `init` returns `dir` relative to cwd (".metaproject/flows/<name>"), so joining
// it onto the flows root again would double the prefix. Everything below works
// in the bare directory name, which is also what `--flow` accepts.
async function frozenFlow(root: string, title: string): Promise<string> {
  const service = createFlowService(deps());
  const created = await service.init({ cwd: root, title });
  const dir = path.basename(created.dir);
  await writeFile(
    path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: the fixture criterion holds\n",
    "utf8",
  );
  await service.freeze({ cwd: root, id: dir });
  return dir;
}

/** Staleness WITHOUT an edit — the shape flow 002 is in. */
async function staleTheChecksum(root: string, dir: string, filler = "0"): Promise<void> {
  const flowPath = path.join(root, ".metaproject", "flows", dir, "flow.json");
  const state = JSON.parse(await readFile(flowPath, "utf8")) as Record<string, unknown>;
  state.acChecksum = "sha256:" + filler.repeat(64);
  await writeFile(flowPath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

describe("flow ac reseal", () => {
  test("re-seals a stale checksum over an unchanged file and KEEPS the confirmations", async () => {
    const root = await realRepo();
    try {
      const service = createFlowService(deps());
      const dir = await frozenFlow(root, "Reseal fixture");
      await service.acConfirm({ cwd: root, id: dir, criterion: "AC1", note: "evidence recorded" });

      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "fixture"]);
      await staleTheChecksum(root, dir);

      const resealed = await service.acReseal({
        cwd: root,
        id: dir,
        reason: "checksum predates the recorded history",
      });

      // The point of the whole command: the confirmation survived.
      expect(Object.keys(resealed.acConfirmed)).toEqual(["AC1"]);
      expect(resealed.acConfirmed.AC1?.note).toBe("evidence recorded");
      expect(resealed.acChecksum).not.toBe("sha256:" + "0".repeat(64));

      // And the guard no longer fires: a command that calls assertAcIntact runs.
      await expect(service.get({ cwd: root, id: dir })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses when the criteria file has been edited — reseal is not a way to accept an edit", async () => {
    const root = await realRepo();
    try {
      const service = createFlowService(deps());
      const dir = await frozenFlow(root, "Edited fixture");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "fixture"]);
      await staleTheChecksum(root, dir);

      // The edit reseal must never launder.
      await appendFile(
        path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"),
        "- AC2: a criterion nobody confirmed\n",
        "utf8",
      );

      await expect(
        service.acReseal({ cwd: root, id: dir, reason: "trying to sneak a criterion in" }),
      ).rejects.toThrow(/refusing/i);

      // It names the alternative rather than leaving the caller stuck.
      await expect(
        service.acReseal({ cwd: root, id: dir, reason: "trying to sneak a criterion in" }),
      ).rejects.toThrow(/ac update/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses when the file is untracked — an uncommitted file has nothing to compare against", async () => {
    const root = await realRepo();
    try {
      const service = createFlowService(deps());
      const dir = await frozenFlow(root, "Untracked fixture");
      // Deliberately never committed.
      await staleTheChecksum(root, dir);

      await expect(
        service.acReseal({ cwd: root, id: dir, reason: "never committed" }),
      ).rejects.toThrow(/changed|not tracked/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses outside a git work tree — no evidence must not read the same as clean", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-reseal-nogit-"));
    try {
      const service = createFlowService(deps());
      const dir = await frozenFlow(root, "No repo");
      await staleTheChecksum(root, dir, "1");

      await expect(
        service.acReseal({ cwd: root, id: dir, reason: "no repo here" }),
      ).rejects.toThrow(/work tree|not tracked|cannot be established/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses when the checksum already matches — nothing stale, nothing re-sealed", async () => {
    const root = await realRepo();
    try {
      const service = createFlowService(deps());
      const dir = await frozenFlow(root, "Already sealed");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "fixture"]);

      await expect(
        service.acReseal({ cwd: root, id: dir, reason: "nothing to do" }),
      ).rejects.toThrow(/already matches/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires a reason, like every other state-changing flow command", async () => {
    const root = await realRepo();
    try {
      const service = createFlowService(deps());
      const dir = await frozenFlow(root, "No reason");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-q", "-m", "fixture"]);
      await staleTheChecksum(root, dir);

      await expect(service.acReseal({ cwd: root, id: dir, reason: "  " })).rejects.toThrow(
        /requires --reason/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

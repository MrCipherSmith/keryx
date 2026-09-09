// AFC-22 (flow 236 T13, F236-03): a working-tree diff that could not be taken
// is not an empty one.
//
// `gitDiff` was `try { … } catch { return ""; }` and `diffStatLine` renders an
// empty string as "no working-tree changes". Measured on the pre-fix code, the
// three cwds below produced identical bytes — 0, sha256 `e3b0c442…` — so a
// corrupt repository and a clean tree were the same recorded fact. Those bytes
// become `evidence[0]`, with `revision` = sha256 of them, and a verifier then
// confirms an intact record of a measurement that never happened.
//
// Every failure here is induced on disk against the real git binary. A mocked
// `execFile` would not do: what made the defect invisible is that git's own
// failure output for a corrupt repository is indistinguishable, at the
// `catch`, from a clean tree's empty stdout.
//
// Revert `gitDiff` to `catch { return "" }` and every test in the first two
// blocks goes red.

import { expect, test, describe } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DIFF_UNAVAILABLE_KIND, diffStatLine, gitDiff, unmeasurableDiffBody } from "./wrap-up-evidence";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** What actually gets persisted and hashed for a given diff outcome. */
function persisted(diff: Awaited<ReturnType<typeof gitDiff>>): { kind: string; body: string } {
  return diff.kind === "measured"
    ? { kind: "diff", body: diff.text }
    : { kind: DIFF_UNAVAILABLE_KIND, body: unmeasurableDiffBody(diff.detail) };
}

async function cleanRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-wrapup-evidence-clean-"));
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd, stdio: "ignore" });
  await writeFile(path.join(cwd, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd, stdio: "ignore" });
  return cwd;
}

describe("gitDiff separates 'not measured' from 'measured, and empty'", () => {
  test("a genuinely clean tree is a MEASURED empty diff", async () => {
    const cwd = await cleanRepo();
    try {
      const diff = await gitDiff(cwd);
      expect(diff.kind).toBe("measured");
      expect(diffStatLine(diff)).toBe("no working-tree changes");
      expect(persisted(diff).kind).toBe("diff");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a dirty tree is a measured, non-empty diff with a real stat line", async () => {
    const cwd = await cleanRepo();
    try {
      await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
      const diff = await gitDiff(cwd);
      expect(diff.kind).toBe("measured");
      if (diff.kind === "measured") expect(diff.text).toContain("+two");
      expect(diffStatLine(diff)).toMatch(/^working-tree diff: \+\d+\/-\d+ line\(s\)$/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a directory that is not a git repository is UNMEASURABLE, and says so", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "keryx-wrapup-evidence-norepo-"));
    try {
      const diff = await gitDiff(cwd);
      expect(diff.kind).toBe("unmeasurable");
      expect(diffStatLine(diff)).toContain("NOT MEASURED");
      expect(persisted(diff).kind).toBe(DIFF_UNAVAILABLE_KIND);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a repository whose `.git/HEAD` is corrupt is UNMEASURABLE, not a clean tree", async () => {
    const cwd = await cleanRepo();
    try {
      // Deliberately leave a real, uncommitted edit in the tree first: this is
      // the worst case — a diff that genuinely exists and cannot be read.
      await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
      await writeFile(path.join(cwd, ".git", "HEAD"), "corrupt");

      const diff = await gitDiff(cwd);
      expect(diff.kind).toBe("unmeasurable");
      expect(persisted(diff).kind).toBe(DIFF_UNAVAILABLE_KIND);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a cwd that does not exist is UNMEASURABLE (git cannot even be started there)", async () => {
    const diff = await gitDiff(path.join(tmpdir(), "keryx-wrapup-evidence-absent-cwd-does-not-exist"));
    expect(diff.kind).toBe("unmeasurable");
  });

  test("an unreadable object store is UNMEASURABLE", async () => {
    const cwd = await cleanRepo();
    try {
      await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n");
      await chmod(path.join(cwd, ".git", "objects"), 0o000);
      const diff = await gitDiff(cwd);
      expect(diff.kind).toBe("unmeasurable");
    } finally {
      await chmod(path.join(cwd, ".git", "objects"), 0o755).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("what a verifier can confirm", () => {
  test("the recorded bytes for an unmeasurable diff are NOT byte-identical to a clean tree's", async () => {
    const clean = await cleanRepo();
    const broken = await cleanRepo();
    const notRepo = await mkdtemp(path.join(tmpdir(), "keryx-wrapup-evidence-cmp-"));
    try {
      await writeFile(path.join(broken, ".git", "HEAD"), "corrupt");

      const cleanRecord = persisted(await gitDiff(clean));
      const brokenRecord = persisted(await gitDiff(broken));
      const notRepoRecord = persisted(await gitDiff(notRepo));

      // The pre-fix state: all three were "" / e3b0c442… / kind "diff".
      expect(sha256(cleanRecord.body)).toBe(sha256(""));
      expect(sha256(brokenRecord.body)).not.toBe(sha256(cleanRecord.body));
      expect(sha256(notRepoRecord.body)).not.toBe(sha256(cleanRecord.body));

      // And the difference is not merely in the bytes — the evidence KIND, the
      // thing a verifier reads before it reads anything else, differs too.
      expect(cleanRecord.kind).toBe("diff");
      expect(brokenRecord.kind).toBe(DIFF_UNAVAILABLE_KIND);
      expect(notRepoRecord.kind).toBe(DIFF_UNAVAILABLE_KIND);
    } finally {
      await rm(clean, { recursive: true, force: true });
      await rm(broken, { recursive: true, force: true });
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  test("the marker body refuses the reading 'the tree was clean' in words, not only by its kind", async () => {
    const body = unmeasurableDiffBody("fatal: not a git repository");
    expect(body).toContain("NOT MEASURED");
    expect(body).toContain("is NOT evidence that the tree");
    expect(body).toContain("fatal: not a git repository");
    // Never empty: anything that only checks for content still sees something.
    expect(body.trim().length).toBeGreaterThan(0);
  });

  test("a marker built from a reasonless failure still carries a reason line", async () => {
    expect(unmeasurableDiffBody("")).toContain("reason: git exited non-zero and gave no reason");
  });
});

describe("diffStatLine never renders an unmeasured tree as a clean one", () => {
  test("unmeasurable renders NOT MEASURED and carries the detail", () => {
    expect(diffStatLine({ kind: "unmeasurable", detail: "fatal: not a git repository" })).toBe(
      "working-tree diff NOT MEASURED (fatal: not a git repository)",
    );
  });

  test("measured-and-empty still renders the ordinary clean-tree line", () => {
    expect(diffStatLine({ kind: "measured", text: "" })).toBe("no working-tree changes");
    expect(diffStatLine({ kind: "measured", text: "   \n  " })).toBe("no working-tree changes");
  });
});

// `applyEvidenceRedactionFloor` is exercised end-to-end by both producers
// (`machine-wrap-up.test.ts`, `session-wrap-up.test.ts`); what is pinned here
// is only that it cannot turn the marker back into something that reads as a
// measurement.
test("the redaction floor leaves the not-measured marker legible as a marker", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-wrapup-evidence-floor-"));
  try {
    await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
    const { applyEvidenceRedactionFloor } = await import("./wrap-up-evidence");
    const body = unmeasurableDiffBody("fatal: not a git repository");
    const result = await applyEvidenceRedactionFloor(cwd, [
      { name: "decision.diff.txt", content: body, path: ".metaproject/x/decision.diff.txt", source: "tool-output" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodies[0]!.content).toContain("NOT MEASURED");
    expect(result.bodies[0]!.content.trim().length).toBeGreaterThan(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

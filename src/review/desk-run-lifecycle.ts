import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../lib/fs";
import { boardGh, projectGithubConnection } from "./board-github";
import { completeReviewGated } from "./complete-gated";
import { withCompletionLock } from "./completion-lock";
import { writeCoverage } from "./coverage-complete";
import { readExistingReviews } from "./desk-run-legacy";
import { publicReviewText } from "./desk-public-text";
import { computeReadiness } from "./readiness";
import { completeDeskCoverage, deskVerdictHeadline } from "./desk-run-executor-recovery";
import { computeVerdict } from "./verdict";
import { DESK_RUN_SCOPE } from "./desk-run-types";
import type { DeskRunStore } from "./desk-run-store";
import type { DeskReviewAction, DeskReviewCheck, DeskRunKey } from "./desk-run-types";
import type { ManagedReviewManifest } from "./types";

export type DeskLifecycleAction =
  | { action: "readiness"; id: string }
  | { action: "decide"; id: string; decision: DeskReviewAction; reason: string; waive?: string[] };

export async function applyDeskLifecycle(
  store: DeskRunStore, cwd: string, key: DeskRunKey, input: DeskLifecycleAction,
  lookup: NonNullable<Parameters<typeof computeReadiness>[1]>["prLookup"],
): Promise<{ checks: DeskReviewCheck[] } | undefined> {
  return withFileLock(path.join(store.root, "actions", input.id), async () => {
    const attempt = store.byId(input.id);
    if (!attempt || attempt.key.repositoryId !== key.repositoryId || attempt.key.number !== key.number ||
        attempt.key.viewer.toLowerCase() !== key.viewer.toLowerCase()) {
      throw new Error("stale: This review attempt is unavailable.");
    }
    const run = attempt.run;
    const action = input.action === "decide" ? input.decision : "complete";
    const previous = run.decision?.action;
    if (attempt.pid || !run.finishedAt && run.source !== "existing" ||
        ["running", "cancelling", "queued", "recoverable"].includes(run.state)) {
      throw new Error("Stop the running review before changing its outcome.");
    }
    if (previous === "delete" && action !== "delete") throw new Error("This review was deleted.");
    if (action === "restore" && previous !== "archive") throw new Error("Only archived reviews can be restored.");
    if (previous === "archive" && !["restore", "delete", "archive"].includes(action)) {
      throw new Error("Restore this review before changing its outcome.");
    }
    const subject = `https://github.com/${key.repo}/pull/${key.number}`;
    const directory = store.directory(run.id);
    if (existsSync(directory) && realpathSync(directory) !== path.join(realpathSync(store.root), "attempts", run.id)) {
      throw new Error("Invalid local review directory.");
    }
    if (action === "complete") {
      if (run.state === "completed") throw new Error("This review is already complete.");
      let pkg = path.join(directory, "package");
      if (run.source === "existing") {
        pkg = "";
        readExistingReviews(cwd, key, (id, dir) => { if (id === run.id) pkg = dir; });
      }
      if (!pkg || !existsSync(pkg) || !lstatSync(pkg).isDirectory() ||
          !readdirSync(pkg, { recursive: true, withFileTypes: true }).every(entry => entry.isFile() || entry.isDirectory())) {
        throw new Error("No managed review package is available. You can close or archive this attempt.");
      }
      const manifest = JSON.parse(readFileSync(path.join(pkg, "manifest.json"), "utf8")) as ManagedReviewManifest;
      const targetMatches = manifest.target.ref.replace(/\/$/, "").toLowerCase() === subject.toLowerCase() ||
        (manifest.target.repository?.toLowerCase() === key.repo.toLowerCase() && [String(key.number), "#" + key.number].includes(manifest.target.ref));
      if (!targetMatches || !run.headSha || manifest.target.head !== run.headSha ||
          (run.baseSha && manifest.target.base !== run.baseSha)) throw new Error("The managed package does not match this review revision.");
      const auth = await projectGithubConnection(cwd, process.env, key.viewer);
      const prFiles = async () => {
        const raw = await boardGh(cwd, ["pr", "view", subject, "--json", "files"], auth);
        const data = JSON.parse(raw) as { files?: { path: string }[] };
        return Array.isArray(data.files) ? data.files.map(file => file.path) : null;
      };
      const readiness = await computeReadiness(pkg, { prLookup: lookup, prFiles });
      const checks = readiness.items.filter(item => item.status === "fail").map(item => ({
        id: item.id, title: item.title, evidence: publicReviewText(item.evidence, 600),
        canWaive: run.closure !== "completed" && item.id !== "premise-decisions",
      }));
      if (input.action === "readiness") return { checks };
      const waive = input.waive ?? [];
      if (checks.some(check => !check.canWaive || !waive.includes(check.id)) ||
          waive.some(id => !checks.some(check => id === check.id))) {
        throw new Error("The review checks are still open or have changed. Reload the checks before completing.");
      }
      const completed = manifest.status === "closed" && waive.length === 0 ? manifest :
        (await completeReviewGated(cwd, pkg, { head: run.headSha, prLookup: lookup, prFiles,
          ...(waive.length ? { waiveReadiness: [{ items: waive, quote: input.reason }] } : {}),
        })).manifest;
      if (manifest.status === "closed" && run.scope === DESK_RUN_SCOPE && !completed.readiness_waivers?.length) {
        await withCompletionLock(pkg, () => writeCoverage(pkg, { onlyTracked: true }));
      }
      run.closure = "completed";
      run.phase = "Managed package closed";
      const evaluated = await computeVerdict(pkg).catch(() => null);
      const fullyCovered = run.scope === DESK_RUN_SCOPE && evaluated !== null && !completed.readiness_waivers?.length &&
        completeDeskCoverage(pkg, completed.coverage, run.usage, evaluated, true);
      const findings = evaluated?.source !== undefined && evaluated.source !== "none" ? evaluated.counts : run.result?.findings;
      run.result = {
        reviewed: { baseSha: run.baseSha, headSha: run.headSha },
        coverage: fullyCovered ? "complete" : "partial",
        verdict: evaluated ? deskVerdictHeadline(evaluated, fullyCovered) : run.result?.verdict ?? null,
        findings: findings ?? { blocker: 0, major: 0, minor: 0, info: 0 },
        findingsKnown: findings !== undefined,
        report: publicReviewText(readFileSync(path.join(pkg, "report.md"), "utf8"), 524288),
      };
      if (fullyCovered) {
        run.state = "completed";
        run.reason = "The managed package passed the completion checks.";
      }
    }
    if (input.action !== "decide") return;
    if (action === "close") {
      if (run.closure || run.state === "completed") throw new Error("This review is already closed.");
      run.closure = "closed";
    }
    if (action === "delete") {
      if (run.source !== "existing") await rm(directory, { recursive: true, force: true });
      // Keep the scoped tombstone so deleted imports do not reappear and the watcher does not repeat a paid run.
      run.result = null;
      delete run.reviewerProgress;
      delete run.retryableBeforeSpend;
    }
    run.decision = { action, reason: input.reason.trim(), at: new Date().toISOString() };
    store.save(attempt);
  }, { timeoutMs: 30_000 });
}

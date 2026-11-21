import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { setPrefs } from "../lib/prefs";
import { gitInfo, openPullRequest, prInfo, type GitInfo, type PrInfo } from "../platform/commands";
import { CHANGES_REQUESTED_TITLE, ciTitle, prTitle, samePr, threadsTitle } from "./gitPrText";

const POLL_MS = 60_000;

/**
 * The project's branch and its open PR, read on mount, when a turn ends and every minute while
 * the window is visible. Both reads fail quietly: no git or no PR just means nothing to show.
 */
function useGitStatus(cwd: string, busy: boolean): { git: GitInfo | null; pr: PrInfo | null } {
  const [git, setGit] = useState<GitInfo | null>(null);
  const [pr, setPr] = useState<PrInfo | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    // A turn's end is when the branch and the PR's checks are most likely to have changed.
    if (busy) return;
    let live = true;
    const refresh = async () => {
      const mine = ++seq.current;
      const g = await gitInfo(cwd).catch(() => null);
      if (!live || mine !== seq.current) return;
      setGit((old) => (JSON.stringify(old) === JSON.stringify(g) ? old : g));
      const p = g?.branch ? await prInfo(cwd).catch(() => null) : null;
      if (!live || mine !== seq.current) return;
      setPr((old) => (samePr(old, p) ? old : p));
    };
    void refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cwd, busy]);

  return { git, pr };
}

/** The changed-files counter: opens the side panel on the Changes tab. */
export function ChangedFilesButton({ count }: { count: number }) {
  return (
    <button
      type="button"
      className="git-dirty"
      title="Show the changed files"
      aria-label={`${count} changed file${count === 1 ? "" : "s"}: open the Changes tab`}
      onClick={() => setPrefs({ sidePanel: "changes" })}
    >
      <Icon name="pencil" size={12} />
      {count}
    </button>
  );
}

/** Branch, worktree, PR link, CI dot and review marks, in the composer footer. Renders nothing outside git. */
export const GitStatus = memo(function GitStatus({ cwd, busy }: { cwd: string; busy: boolean }) {
  const { git, pr } = useGitStatus(cwd, busy);
  const name = git?.branch ?? git?.commit;
  if (!git || !name) return null;
  const ci = pr ? ciTitle(pr) : null;
  return (
    <span className="git-status">
      <span className="git-branch" title={git.worktree ? `Branch ${name} in worktree ${git.worktree}` : `Branch ${name}`}>
        <Icon name="branch" size={12} />
        <span className="git-name">{name}</span>
        {git.worktree ? <span className="git-worktree">{git.worktree}</span> : null}
      </span>
      {git.changed > 0 ? <ChangedFilesButton count={git.changed} /> : null}
      {pr ? (
        <>
          <button type="button" className="git-pr" title={prTitle(pr)} onClick={() => void openPullRequest(pr.url).catch(() => {})}>
            <Icon name="pr" size={12} />#{pr.number}
          </button>
          {ci ? <span className={`git-ci git-ci-${pr.ci}`} title={ci} role="img" aria-label={ci} /> : null}
          {pr.reviewDecision === "CHANGES_REQUESTED" ? (
            <span className="git-changes" title={CHANGES_REQUESTED_TITLE} role="img" aria-label={CHANGES_REQUESTED_TITLE}>
              <Icon name="xCircle" size={12} />
            </span>
          ) : null}
          {pr.unresolvedThreads > 0 ? (
            <span className="git-threads" title={threadsTitle(pr.unresolvedThreads)}>
              <Icon name="comment" size={12} />
              {pr.unresolvedThreads}
            </span>
          ) : null}
        </>
      ) : null}
    </span>
  );
});

// The review bot runs on a checkout with a model key and a token that can write to the
// pull request. A fork PR is code its author controls: it must not reach either.

export type PullFacts = {
  state: "open" | "closed" | "unknown";
  merged: boolean;
  mergedAt: string | null;
  headSha: string | null;
  baseSha: string | null;
  baseRef: string | null;
  headRepo: string | null;
  baseRepo: string | null;
  headRepoId: number | null;
  baseRepoId: number | null;
};

export type BotVerdict = { ok: true } | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function side(raw: Record<string, unknown> | null): { sha: string | null; ref: string | null; repo: string | null; repoId: number | null } {
  const repo = record(raw?.repo);
  const id = repo?.id;
  return {
    sha: text(raw?.sha)?.toLowerCase() ?? null,
    ref: text(raw?.ref),
    repo: text(repo?.full_name),
    repoId: typeof id === "number" ? id : null,
  };
}

export function readPullFacts(raw: unknown): PullFacts {
  const object = record(Array.isArray(raw) ? raw[0] : raw);
  const head = side(record(object?.head));
  const base = side(record(object?.base));
  const state = text(object?.state);
  const mergedAt = text(object?.merged_at);
  return {
    state: state === "open" || state === "closed" ? state : "unknown",
    merged: object?.merged === true || mergedAt !== null,
    mergedAt,
    headSha: head.sha,
    baseSha: base.sha,
    baseRef: base.ref,
    headRepo: head.repo,
    baseRepo: base.repo,
    headRepoId: head.repoId,
    baseRepoId: base.repoId,
  };
}

export function checkSameRepo(facts: PullFacts): BotVerdict {
  if (facts.baseRepo === null) {
    return { ok: false, reason: "Refusing: GitHub did not report the base repository, so the pull request cannot be shown to come from this repository." };
  }
  if (facts.headRepo === null) {
    return {
      ok: false,
      reason: "Refusing: GitHub did not report the head repository (a deleted fork reads this way). Only pull requests from the same repository are reviewed.",
    };
  }
  const sameName = facts.headRepo.toLowerCase() === facts.baseRepo.toLowerCase();
  const idsDiffer =
    typeof facts.headRepoId === "number" && typeof facts.baseRepoId === "number" && facts.headRepoId !== facts.baseRepoId;
  if (!sameName || idsDiffer) {
    return {
      ok: false,
      reason: `Refusing: this pull request comes from a fork (head ${facts.headRepo}, base ${facts.baseRepo}). The review bot runs only on same-repository pull requests, before any model call, so a fork's code never sees the model key or the token.`,
    };
  }
  return { ok: true };
}

export function checkPullOpen(facts: PullFacts): BotVerdict {
  if (facts.merged) {
    return { ok: false, reason: `Refusing: the pull request is merged${facts.mergedAt === null ? "" : ` (${facts.mergedAt})`}. Only an open pull request is reviewed or posted to.` };
  }
  if (facts.state !== "open") {
    return { ok: false, reason: `Refusing: the pull request is ${facts.state}, not open.` };
  }
  return { ok: true };
}

export function checkPullForBot(facts: PullFacts): BotVerdict {
  const same = checkSameRepo(facts);
  return same.ok ? checkPullOpen(facts) : same;
}

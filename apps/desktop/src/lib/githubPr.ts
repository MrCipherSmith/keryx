const REPOSITORY = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;

export function isGithubRepository(value: string): boolean {
  return REPOSITORY.test(value) && !/\/\.{1,2}$/.test(value);
}

/** Return only owner/repo; never forward a remote's credentials, parameters or other hosts. */
export function githubRepositoryFromOrigin(origin: string): string | null {
  const raw = origin.trim();
  const ssh = /^git@github\.com:(.+)$/i.exec(raw);
  const match = ssh ?? /^(?:https:\/\/|ssh:\/\/git@)github\.com\/(.+)$/i.exec(raw);
  const repo = match?.[1]?.replace(/\/$/, "").replace(/\.git$/i, "");
  return repo && isGithubRepository(repo) ? repo : null;
}

/**
 * Validate an explicit GitHub pull-request link and return its canonical form: https://github.com only, the
 * subpage and fragment kept, the query dropped. A PR of any repository is accepted whatever the project's own
 * remote says, and the answer never depends on whether that remote has been looked up yet.
 */
export function githubPrUrl(href: string | null): string | null {
  if (!href || !/^https:\/\/github\.com\//i.test(href)) return null;
  try {
    const url = new URL(href);
    const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d{0,11})((?:\/(?:files|commits|checks|conversation))?)\/?$/.exec(url.pathname);
    const repo = match?.[1];
    const number = match?.[2];
    if (url.origin !== "https://github.com" || !repo || !number || !isGithubRepository(repo)) return null;
    return `https://github.com/${repo}/pull/${number}${match?.[3] ?? ""}${url.hash}`;
  } catch {
    return null;
  }
}

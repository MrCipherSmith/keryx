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

export function githubPrUrl(href: string | null): string | null {
  if (!href || !/^https:\/\/github\.com\//i.test(href)) return null;
  try {
    const url = new URL(href);
    const match = /^\/([^/]+\/[^/]+)\/pull\/[1-9]\d{0,11}(?:\/(?:files|commits|checks|conversation)\/?)?\/?$/.exec(url.pathname);
    return url.origin === "https://github.com" && match?.[1] && isGithubRepository(match[1]) ? url.href : null;
  } catch {
    return null;
  }
}

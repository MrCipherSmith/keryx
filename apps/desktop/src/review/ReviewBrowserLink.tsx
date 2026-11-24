import type { MouseEvent, ReactNode } from "react";
import { githubPrUrl } from "../lib/githubPr";
import { openExternal, openPullRequest } from "../platform/commands";

/** Review bodies and check destinations come from GitHub and may contain arbitrary URLs. */
export function reviewUrl(raw: string | null): string | null {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The app blocks navigation away from itself, so a review link is handed to the system browser:
 * a pull request through `openPullRequest`, anything else through `openExternal`.
 */
export function openReviewLink(url: string): Promise<void> {
  return (githubPrUrl(url) ? openPullRequest : openExternal)(url);
}

/** `onOpen` receives the checked https URL; without it the anchor relies on a parent's click handler. */
export function ReviewBrowserLink({ url, children, className = "link-btn", label, onOpen }: {
  url: string | null; children: ReactNode; className?: string; label?: string; onOpen?: (url: string) => void;
}) {
  const href = reviewUrl(url);
  if (!href) return label ? null : <>{children}</>;
  const open = onOpen && ((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button > 1) return;
    event.preventDefault();
    onOpen(href);
  });
  return <a className={className} href={href} rel="noreferrer" aria-label={label} title={label} onClick={open} onAuxClick={open}>{children}</a>;
}

import type { ReactNode } from "react";

/** Review bodies and check destinations come from GitHub and may contain arbitrary URLs. */
export function reviewUrl(raw: string | null): string | null {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function ReviewBrowserLink({ url, children, className = "link-btn", label }: {
  url: string | null; children: ReactNode; className?: string; label?: string;
}) {
  const href = reviewUrl(url);
  if (href) return <a className={className} href={href} rel="noreferrer" aria-label={label} title={label}>{children}</a>;
  return label ? null : <>{children}</>;
}

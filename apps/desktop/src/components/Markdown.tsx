import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useDeferredValue, useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function onClick(e: React.MouseEvent<HTMLDivElement>) {
  // Never navigate the app's web view away; links are inert (the model's links are untrusted).
  if ((e.target as HTMLElement).closest("a")) e.preventDefault();
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

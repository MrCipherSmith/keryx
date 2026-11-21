import { useMemo } from "react";
import { renderMarkdown } from "../components/Markdown";

export function ReviewReportMarkdown({ text, label, className }: { text: string; label: string; className?: string }) {
  const html = useMemo(() => {
    const fragment = document.createElement("template");
    fragment.innerHTML = renderMarkdown(text);
    for (const element of fragment.content.querySelectorAll("script, img, source, video, audio, iframe, object, embed")) element.remove();
    for (const link of fragment.content.querySelectorAll("a")) link.removeAttribute("href");
    return fragment.innerHTML;
  }, [text]);
  return <div className={["md", className].filter(Boolean).join(" ")} tabIndex={0} aria-label={label}
    dangerouslySetInnerHTML={{ __html: html }} />;
}

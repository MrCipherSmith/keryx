import { memo, useMemo } from "react";
import { renderMarkdown } from "../components/Markdown";
import { reviewUrl } from "./ReviewBrowserLink";

// GitHub comments are remote content. Use the shared sanitized Markdown without
// session-only enhancements such as local image previews or running shell blocks.
export const DiscussionMarkdown = memo(function DiscussionMarkdown({ body }: { body: string }) {
  const markup = useMemo(() => {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown(body);
    for (const link of template.content.querySelectorAll("a")) {
      const href = reviewUrl(link.getAttribute("href"));
      if (!href) link.replaceWith(...link.childNodes);
      else {
        link.href = href;
        link.removeAttribute("target");
        link.rel = "noreferrer";
      }
    }
    return { __html: template.innerHTML };
  }, [body]);
  return <div className="md discussion-markdown" dangerouslySetInnerHTML={markup} />;
});

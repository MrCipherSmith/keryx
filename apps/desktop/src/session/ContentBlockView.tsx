import { memo, useMemo, useState } from "react";
import type { ContentBlock } from "../acp/types";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { looksLikeUnifiedDiff } from "../components/unifiedDiff";
import { blockView, fenced, uriName } from "./contentBlock";

/** Plain output text: a diff reads as a coloured diff, everything else as it is. */
export const OutputText = memo(function OutputText({ text }: { text: string }) {
  const diff = useMemo(() => looksLikeUnifiedDiff(text), [text]);
  if (diff) return <Markdown text={fenced(text, "diff")} className="md-output" />;
  return <pre className="out-pre">{text}</pre>;
});

function ImageView({ src, alt }: { src: string; alt: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <button type="button" className={`feed-image${zoomed ? " is-zoomed" : ""}`} onClick={() => setZoomed((z) => !z)} title={zoomed ? "Shrink" : "Show full size"}>
      <img src={src} alt={alt} draggable={false} />
    </button>
  );
}

/** One ACP content block as itself: a picture, a link chip, a file with its text, or a short label. */
export const ContentBlockView = memo(function ContentBlockView({ block }: { block: ContentBlock }) {
  const v = useMemo(() => blockView(block), [block]);
  switch (v.kind) {
    case "text": {
      const t = v.text.trim();
      return t ? <OutputText text={t} /> : null;
    }
    case "image":
      return <ImageView src={v.src} alt={v.alt} />;
    case "link":
      // Links from the agent are inert, like the ones in its Markdown: the chip names the target.
      return (
        <div className="feed-chip" title={v.uri}>
          <Icon name="file" size={13} />
          <span className="feed-chip-name truncate">{v.name}</span>
          {v.detail ? <span className="feed-chip-detail">{v.detail}</span> : null}
          {v.uri && v.uri !== v.name ? <span className="feed-chip-uri mono truncate">{v.uri}</span> : null}
        </div>
      );
    case "file":
      return (
        <div className="feed-resource">
          <div className="feed-resource-head" title={v.uri}>
            <Icon name="file" size={13} />
            <span className="mono truncate">{uriName(v.uri)}</span>
          </div>
          <Markdown text={fenced(v.text, v.lang)} className="md-output" />
        </div>
      );
    case "binary":
      return (
        <div className="feed-chip" title={v.uri}>
          <Icon name="file" size={13} />
          <span className="feed-chip-name truncate">{uriName(v.uri)}</span>
          <span className="feed-chip-detail">{v.detail}</span>
        </div>
      );
    case "unknown":
      return <div className="feed-chip is-muted">{v.label}</div>;
  }
});

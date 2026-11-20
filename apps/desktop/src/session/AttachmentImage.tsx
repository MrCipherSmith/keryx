import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/format";
import { localImage } from "../platform/commands";

const LIMIT = 3;
let running = 0;
const queue: Array<() => void> = [];

function schedulePreview(run: () => Promise<void>): () => void {
  const start = () => {
    running++;
    const done = () => { running--; queue.shift()?.(); };
    void run().then(done, done);
  };
  if (running < LIMIT) start();
  else queue.push(start);
  return () => {
    const index = queue.indexOf(start);
    if (index >= 0) queue.splice(index, 1);
  };
}

export function AttachmentImage({ path, alt, eager = false, load = localImage }: {
  path: string;
  alt: string;
  eager?: boolean;
  load?: (path: string) => Promise<string>;
}) {
  const placeholder = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let cancel: (() => void) | undefined;
    const start = () => {
      if (cancel) return;
      cancel = schedulePreview(async () => {
        try {
          const url = await load(path);
          if (active) setSrc(url);
        } catch {
          if (active) setFailed(true);
        }
      });
    };
    const target = placeholder.current;
    let observer: IntersectionObserver | undefined;
    if (eager || !target || typeof IntersectionObserver === "undefined") start();
    else {
      observer = new IntersectionObserver((entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        start();
      }, { rootMargin: "150px" });
      observer.observe(target);
    }
    return () => { active = false; observer?.disconnect(); cancel?.(); };
  }, [eager, load, path]);

  return src && !failed ? (
    <img className="sent-image" src={src} alt={alt} onError={() => setFailed(true)} />
  ) : <span ref={placeholder} className="sent-image-label">{failed ? "Image no longer available" : "Loading image…"} · {basename(path)}</span>;
}

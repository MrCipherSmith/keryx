import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/format";
import { localImage } from "../platform/commands";

const LIMIT = 3;
const MAX_QUEUED = 24;
let running = 0;
interface Job { start: () => void; eager: boolean; onDrop: () => void }
const queue: Job[] = [];

function schedulePreview(run: () => Promise<void>, eager: boolean, onDrop: () => void): () => void {
  const start = () => {
    running++;
    const done = () => { running--; queue.shift()?.start(); };
    void run().then(done, done);
  };
  if (running < LIMIT) return (start(), () => {});
  const job: Job = { start, eager, onDrop };
  if (eager) queue.unshift(job);
  else queue.push(job);
  while (queue.length > MAX_QUEUED) {
    const oldest = queue.findIndex((queued) => !queued.eager);
    if (oldest < 0) break;
    const [dropped] = queue.splice(oldest, 1);
    dropped?.onDrop();
  }
  return () => {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  };
}

export function AttachmentImage({ path, alt, eager = false, load = localImage }: {
  path: string;
  alt: string;
  eager?: boolean;
  load?: (path: string) => Promise<string>;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const height = useRef<number>();
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(false);
  const visible = eager || inView;
  useEffect(() => {
    if (eager) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    }, { rootMargin: "150px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, node]);
  useEffect(() => {
    if (!visible) { setSrc(undefined); return; }
    let active = true;
    const cancel = schedulePreview(async () => {
      try {
        const url = await load(path);
        if (active) setSrc(url);
      } catch {
        if (active) setFailed(true);
      }
    }, eager, () => { if (active) setSrc(undefined); });
    return () => { active = false; cancel(); };
  }, [visible, eager, load, path]);

  return src && !failed ? (
    <img ref={setNode} className="sent-image" src={src} alt={alt} onLoad={(e) => { height.current = e.currentTarget.offsetHeight; }} onError={() => setFailed(true)} />
  ) : <span ref={setNode} className="sent-image-label" style={height.current && !failed ? { display: "inline-block", minHeight: height.current } : undefined}>{failed ? "Image no longer available" : "Loading image…"} · {basename(path)}</span>;
}

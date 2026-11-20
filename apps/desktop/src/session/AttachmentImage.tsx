import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/format";
import { localImage } from "../platform/commands";

const LIMIT = 3;
const BUSY_DELAYS = [300, 900, 2000, 4000];
const RESOLVED_MAX = 8;
let running = 0;
interface Job { start: () => void; eager: boolean }
const queue: Job[] = [];

/** Small LRU of resolved image URLs by path (oldest entry is dropped on overflow). */
const resolved = new Map<string, string>();
function remember(path: string, url: string): void {
  resolved.delete(path);
  resolved.set(path, url);
  if (resolved.size > RESOLVED_MAX) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
}

function schedulePreview(run: () => Promise<void>, eager: boolean): () => void {
  const start = () => {
    running++;
    const done = () => { running--; queue.shift()?.start(); };
    void run().then(done, done);
  };
  if (running < LIMIT) { start(); return () => {}; }
  const job: Job = { start, eager };
  if (eager) queue.unshift(job);
  else queue.push(job);
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
    setFailed(false);
    setSrc(undefined);
    height.current = undefined;
  }, [path, load]);
  useEffect(() => {
    if (!visible) { setSrc(undefined); return; }
    const hit = resolved.get(path);
    if (hit) {
      remember(path, hit);
      setSrc(hit);
      return;
    }
    let active = true;
    let cancel: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      cancel = schedulePreview(async () => {
        try {
          const url = await load(path);
          if (!active) return;
          remember(path, url);
          setSrc(url);
        } catch (err) {
          if (!active) return;
          const delay = BUSY_DELAYS[n];
          if (err instanceof Error && /busy/i.test(err.message) && delay !== undefined) {
            timer = setTimeout(() => { if (active) attempt(n + 1); }, delay);
          } else {
            setFailed(true);
          }
        }
      }, eager);
    };
    attempt(0);
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); cancel(); };
  }, [visible, eager, load, path]);

  return (
    <span ref={setNode} className="sent-image-slot">
      {src && !failed ? (
        <img className="sent-image" src={src} alt={alt} onLoad={(e) => { height.current = e.currentTarget.offsetHeight; }} onError={() => setFailed(true)} />
      ) : (
        <span className="sent-image-label" style={{ display: "inline-block", minHeight: height.current ?? 96 }}>{failed ? "Image no longer available" : "Loading image…"} · {basename(path)}</span>
      )}
    </span>
  );
}

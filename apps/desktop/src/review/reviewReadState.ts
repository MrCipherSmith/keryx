// A receipt belongs to one message. Two windows can acknowledge different replies concurrently.
const namespace = "keryx.review.read";
const changedEvent = "keryx-review-read-changed";
const legacyKey = (viewer: string, repo: string, pr: number) => JSON.stringify([namespace, viewer, repo, pr]);
const messageKey = (viewer: string, repo: string, pr: number, id: string) =>
  JSON.stringify([namespace, viewer.toLowerCase(), repo, pr, id]);

export function readReplies(viewer: string, repo: string, pr: number, ids: readonly string[]): Set<string> {
  const read = new Set<string>();
  try {
    const legacy = localStorage.getItem(legacyKey(viewer, repo, pr));
    if (legacy) {
      try {
        const values: unknown = JSON.parse(legacy);
        if (Array.isArray(values)) for (const id of values) if (typeof id === "string") read.add(id);
      } catch { /* A damaged old list does not invalidate individual receipts. */ }
    }
    for (const id of ids) if (localStorage.getItem(messageKey(viewer, repo, pr, id)) !== null) read.add(id);
  } catch { /* Storage can be unavailable in a restricted view. */ }
  return read;
}

export function isReplyRead(viewer: string, repo: string, pr: number, id: string) {
  return readReplies(viewer, repo, pr, [id]).has(id);
}

export function markRepliesRead(viewer: string, repo: string, pr: number, ids: readonly string[]) {
  try {
    for (const id of ids) localStorage.setItem(messageKey(viewer, repo, pr, id), "1");
  } finally {
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: [namespace, viewer, repo, pr] }));
  }
}

export function subscribeReviewReads(viewer: string, repo: string, pr: number | undefined, onChange: () => void) {
  let timer: number | undefined;
  const notify = () => {
    if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; onChange(); }, 0);
  };
  const match = (key: unknown) => {
    if (Array.isArray(key) && key[0] === namespace && typeof key[1] === "string" &&
        key[1].toLowerCase() === viewer.toLowerCase() && key[2] === repo && (pr === undefined || key[3] === pr)) notify();
  };
  const stored = (event: StorageEvent) => {
    if (event.key === null) { notify(); return; }
    try { match(JSON.parse(event.key)); } catch { /* An unrelated preference changed. */ }
  };
  const local = (event: Event) => match((event as CustomEvent).detail);
  window.addEventListener("storage", stored);
  window.addEventListener(changedEvent, local);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener("storage", stored);
    window.removeEventListener(changedEvent, local);
  };
}

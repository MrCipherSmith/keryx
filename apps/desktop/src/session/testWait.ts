/** Poll until `cond` is truthy, flushing React updates through `act` between checks. */
export async function waitFor(
  cond: () => unknown,
  act: (fn: () => Promise<void>) => Promise<void>,
  timeoutMs = 2000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

/** True once no attachment is being saved (the composer shows its "Adding attachments…" status only while pending). */
export const savingDone = (host: ParentNode): boolean => !host.querySelector('.composer-image-status[role="status"]');

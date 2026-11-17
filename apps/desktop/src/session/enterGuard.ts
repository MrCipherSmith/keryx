// When Enter in a dialog answers it. Pure, so the guards can be tested without a DOM.

/** Ignore Enter this long after a dialog appears: a keystroke aimed at the composer must not answer it. */
export const ENTER_GUARD_MS = 300;

/**
 * Elements that handle Enter themselves, per dialog. The permission dialog counts its text fields too
 * (Enter there must never approve); in ask_user, Enter in the free-text field submits the answer, so
 * only buttons, links and summaries count.
 */
export const PERMISSION_CONTROLS = 'input, textarea, select, button, a, summary, [contenteditable=""], [contenteditable="true"]';
export const ASK_CONTROLS = "button, a, summary";

export interface EnterKey {
  key: string;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** ms since the dialog opened. */
  sinceOpenMs: number;
  /** The key started on an element that handles Enter itself; the caller decides which (see *_CONTROLS). */
  onControl: boolean;
}

/** The slice of a keyboard event enterKeyOf reads; a React or DOM event fits. */
export interface KeyEventLike {
  key: string;
  repeat: boolean;
  defaultPrevented: boolean;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  target: unknown;
}

/** Build the EnterKey both dialogs judge, from the event, the dialog's open time and its control set. */
export function enterKeyOf(e: KeyEventLike, openedAt: number, controls: string, now: number): EnterKey {
  const t = e.target as { closest?: (sel: string) => unknown } | null;
  return {
    key: e.key,
    repeat: e.repeat,
    isComposing: e.nativeEvent?.isComposing ?? e.isComposing ?? false,
    defaultPrevented: e.defaultPrevented,
    sinceOpenMs: now - openedAt,
    onControl: typeof t?.closest === "function" ? !!t.closest(controls) : false,
  };
}

/** "pass": leave the key alone; "swallow": stop it and do nothing; "submit": answer the dialog. */
export type EnterVerdict = "pass" | "swallow" | "submit";

/** ask_user: Enter submits unless it is a repeat, comes right after open, or lands on a button/link. */
export function askEnter(k: EnterKey): EnterVerdict {
  if (k.key !== "Enter" || k.isComposing || k.defaultPrevented) return "pass";
  if (k.repeat || k.sinceOpenMs < ENTER_GUARD_MS) return "swallow";
  if (k.onControl) return "pass";
  return "submit";
}

export type PermissionVerdict<O> = { verdict: "pass" } | { verdict: "swallow" } | { verdict: "submit"; option: O };

/**
 * Permission request: Enter approves `allow` only when there is one, the key is fresh, it did not
 * start on a control, and every box that is partly hidden has been read to its end or expanded.
 */
export function permissionEnter<O>(k: EnterKey & { allow: O | undefined; unread: boolean }): PermissionVerdict<O> {
  if (k.key !== "Enter" || k.isComposing || k.defaultPrevented) return { verdict: "pass" };
  if (k.allow === undefined) return { verdict: "pass" };
  if (k.repeat || k.sinceOpenMs < ENTER_GUARD_MS || k.onControl) return { verdict: "pass" };
  if (k.unread) return { verdict: "swallow" };
  return { verdict: "submit", option: k.allow };
}

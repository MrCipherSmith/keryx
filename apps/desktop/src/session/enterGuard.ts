// When Enter in a dialog answers it. Pure, so the guards can be tested without a DOM.

/** Ignore Enter this long after a dialog appears: a keystroke aimed at the composer must not answer it. */
export const ENTER_GUARD_MS = 300;

export interface EnterKey {
  key: string;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** ms since the dialog opened. */
  sinceOpenMs: number;
  /** The key started on a control that acts on Enter itself (a button, a link, a text field...). */
  onControl: boolean;
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

/**
 * Permission request: Enter approves only when there is an allow option, the key is fresh, it did not
 * start on a control, and every argument box that overflows has been read to its end or expanded.
 */
export function permissionEnter(k: EnterKey & { canAllow: boolean; unread: boolean }): EnterVerdict {
  if (k.key !== "Enter" || k.isComposing || k.defaultPrevented) return "pass";
  if (!k.canAllow || k.repeat || k.sinceOpenMs < ENTER_GUARD_MS || k.onControl) return "pass";
  if (k.unread) return "swallow";
  return "submit";
}

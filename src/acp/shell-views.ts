// The structured view a picker/modal command answers `_keryx/command` with (Keryx Desktop
// Client M2a, specification §3.9.1 "Views"; decision D-10).
//
// A view is data, never behaviour: every action and the form's submit is itself a command
// line the client sends back through `_keryx/command`, so the same text subcommand serves
// the desktop, the readline shell and (later) the TUI modal. The client renders `body`
// beside `rows`; a surface that cannot render a view reads `text`, the plain-text
// rendering built here.

export interface ShellViewAction {
  readonly label: string;
  /** A command line, with its leading slash: `/schedules pause nightly`. */
  readonly command: string;
  /** Present on a destructive or costly action: the question the client asks before sending `command`. */
  readonly confirm?: string;
}

export interface ShellViewRow {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly status?: string;
  readonly actions: readonly ShellViewAction[];
}

export interface ShellViewField {
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "secret" | "choice" | "toggle";
  readonly options?: readonly string[];
  /** Prefilled content; the client starts the field with it. */
  readonly value?: string | boolean;
  /** A hint shown while the field is empty. */
  readonly placeholder?: string;
  /** The client keeps Submit disabled until the field is non-empty. */
  readonly required?: boolean;
}

export interface ShellViewForm {
  readonly fields: readonly ShellViewField[];
  /** A command line with `{fieldId}` placeholders the client fills in. */
  readonly submit: string;
}

export interface ShellView {
  readonly title: string;
  readonly rows: readonly ShellViewRow[];
  readonly body?: string;
  readonly form?: ShellViewForm;
}

export const action = (label: string, command: string, confirm?: string): ShellViewAction => ({
  label,
  command,
  ...(confirm !== undefined ? { confirm } : {}),
});

export const viewRow = (
  id: string,
  label: string,
  options: { readonly detail?: string; readonly status?: string; readonly actions?: readonly ShellViewAction[] } = {},
): ShellViewRow => ({
  id,
  label,
  ...(options.detail !== undefined && options.detail.length > 0 ? { detail: options.detail } : {}),
  ...(options.status !== undefined ? { status: options.status } : {}),
  actions: options.actions ?? [],
});

/** The view as plain text: what a client that does not render views (or the readline shell) shows. */
export function viewText(view: ShellView): string {
  const lines: string[] = [view.title];
  if (view.body !== undefined && view.body.length > 0) lines.push("", view.body.trimEnd());
  if (view.rows.length > 0) lines.push("");
  for (const row of view.rows) {
    lines.push(`${row.label}${row.status !== undefined ? `  [${row.status}]` : ""}`);
    if (row.detail !== undefined) for (const line of row.detail.split("\n")) lines.push(`    ${line}`);
    for (const item of row.actions) lines.push(`    ${item.command}${item.confirm !== undefined ? "  (asks to confirm)" : ""}`);
  }
  if (view.form !== undefined) lines.push("", `form: ${view.form.submit}`);
  return `${lines.join("\n")}\n`;
}

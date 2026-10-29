// Where the native `/product` inspection gets the open report from.
//
// The product index is derived, disposable data behind a narrow door (flow 362): only `keryx product`, the TUI surface and the shell
// that opens it import the module (src/product/never-gates.test.ts), and only the product command reads its data. A native session
// command is none of those, so, exactly as the scheduled digest gets its board (src/scheduler/digest-board.ts, flow 389), it asks a
// reader the product command registers through the CLI registry. With none registered the report is unavailable in this process and
// the command says so; it never reads the index itself.

/** What the reader hands over: the report `keryx product open` prints, or why the index cannot be used. */
export type OpenIntentLoad = { readonly ok: true; readonly report: unknown } | { readonly ok: false; readonly message: string };

export type OpenIntentReader = (projectRoot: string) => Promise<OpenIntentLoad>;

let registered: OpenIntentReader | undefined;

/** The CLI registry calls this once, with the product command's reader; `undefined` clears it. */
export function registerOpenIntentReader(reader: OpenIntentReader | undefined): void {
  registered = reader;
}

/** The registered reader, or `undefined` when this process registered none. */
export function openIntentReader(): OpenIntentReader | undefined {
  return registered;
}

// One match line of `keryx ctx rg`'s summary (`src/commands/ctx.ts`), below both the command that
// renders it and the secret detector whose tests read it back (flow 523 review R3-AR-004): the item
// reaches the model whenever a search's summary does, so a key tail inside one must stay masked whole.
//
// Pure: importing this reads nothing.

/** `  - <line>:<column> <text>`: one match of a file's group in the summary. */
export function rgSummaryItem(line: string | number, column: string | number, text: string): string {
  return `  - ${line}:${column} ${text}`;
}

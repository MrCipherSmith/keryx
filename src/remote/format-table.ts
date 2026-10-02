// Markdown tables for the Telegram renderers (flow 395; AC2, AC6).
//
// A model writes a table as GitHub-flavoured Markdown: a header row, a separator row
// (`| --- | :-: |`) and body rows. Sent as it is, the operator reads raw pipes. This file
// is the one place a table is recognised and measured:
//
//   - `tableAt` finds a table in a list of lines;
//   - `renderTableText` lays it out as aligned monospace text (the HTML `<pre>` body and the
//     plain-text fallback): column widths come from DISPLAY width, so CJK and emoji do not
//     break the alignment, and the separator row is dropped;
//   - the rich renderer (format-rich.ts) takes the same parsed table and writes a native
//     table block;
//   - the splitter (format.ts) asks `renderedRowCost` how long a row will be once rendered, so a
//     part is never longer after rendering than the limit, and repeats the header row.
//
// Pure functions, no I/O.

import { visualWidth } from "../lib/md-blocks";

export type TableAlign = "left" | "center" | "right";

export interface MarkdownTable {
  /** Header cells as written (inline Markdown still in them). */
  header: string[];
  align: TableAlign[];
  /** Body rows, each exactly as wide as the header. */
  rows: string[][];
}

export interface TableMatch {
  table: MarkdownTable;
  /** Index of the first line after the table. */
  end: number;
}

/** A table of more columns than this is left as text: the rich renderer takes at most 20. */
export const MAX_TABLE_COLUMNS = 20;
/**
 * A table with a row longer than this (rendered aligned, in UTF-16 units) is not laid out as padded
 * columns: every cell is padded to its column's widest, so one long cell makes every row that long.
 * It is still a table (rich mode draws it natively) and the text modes lay it out stacked.
 */
export const MAX_TABLE_ROW_COST = 1500;

const SEPARATOR_CELL = /^\s*(:)?-+(:)?\s*$/;

/** The cells of one table line, or undefined when the line has no unescaped pipe. */
export function splitRow(line: string): string[] | undefined {
  const cells: string[] = [];
  let current = "";
  let sawPipe = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      sawPipe = true;
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (!sawPipe) {
    return undefined;
  }
  cells.push(current);
  // A leading and a trailing pipe are decoration: `| a | b |` has two cells, not four.
  if (cells[0]?.trim() === "") {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1]?.trim() === "") {
    cells.pop();
  }
  return cells.map((cell) => cell.trim());
}

/** The alignment of each column when `line` is a separator row, else undefined. */
function separatorAlign(line: string): TableAlign[] | undefined {
  const cells = splitRow(line);
  if (cells === undefined || cells.length === 0) {
    return undefined;
  }
  const align: TableAlign[] = [];
  for (const cell of cells) {
    const match = SEPARATOR_CELL.exec(cell);
    if (match === null) {
      return undefined;
    }
    align.push(match[1] !== undefined && match[2] !== undefined ? "center" : match[2] !== undefined ? "right" : "left");
  }
  return align;
}

/** True when `line` could not be a body row: blank, or no pipe at all. */
function endsTable(line: string): boolean {
  return line.trim().length === 0 || !line.includes("|");
}

function fitRow(cells: readonly string[], width: number): string[] {
  const row = cells.slice(0, width);
  while (row.length < width) {
    row.push("");
  }
  return row;
}

/**
 * The table starting at `lines[start]`, if one does: a header row with a pipe, then a separator
 * row of the same number of cells, then body rows while a line still has a pipe.
 */
export function tableAt(lines: readonly string[], start: number): TableMatch | undefined {
  const headerLine = lines[start];
  const separatorLine = lines[start + 1];
  if (headerLine === undefined || separatorLine === undefined || endsTable(headerLine)) {
    return undefined;
  }
  const header = splitRow(headerLine);
  const align = separatorAlign(separatorLine);
  if (header === undefined || align === undefined || header.length !== align.length || header.length > MAX_TABLE_COLUMNS) {
    return undefined;
  }
  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length && !endsTable(lines[end] as string)) {
    const cells = splitRow(lines[end] as string);
    if (cells === undefined) {
      break;
    }
    rows.push(fitRow(cells, header.length));
    end += 1;
  }
  return { table: { header, align, rows }, end };
}

/** Visible text of one cell: emphasis markers, code ticks and link syntax removed. */
export function plainCell(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]*)\)/g, (_all, label: string, url: string) => (label.trim().length > 0 ? `${label} (${url})` : url))
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();
}

/** Column display widths over the header and every row. */
export function columnWidths(table: MarkdownTable): number[] {
  return table.header.map((cell, column) => {
    let widest = visualWidth(plainCell(cell));
    for (const row of table.rows) {
      widest = Math.max(widest, visualWidth(plainCell(row[column] as string)));
    }
    return widest;
  });
}

function pad(text: string, width: number, align: TableAlign): string {
  const gap = Math.max(0, width - visualWidth(text));
  if (align === "right") {
    return `${" ".repeat(gap)}${text}`;
  }
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(gap - left)}`;
  }
  return `${text}${" ".repeat(gap)}`;
}

const COLUMN_GAP = " │ ";

/** One rendered row of the aligned layout (trailing spaces trimmed). */
export function renderTableRow(cells: readonly string[], widths: readonly number[], align: readonly TableAlign[]): string {
  return cells
    .map((cell, column) => pad(plainCell(cell), widths[column] as number, align[column] as TableAlign))
    .join(COLUMN_GAP)
    .trimEnd();
}

/** How the text modes lay a table out. Rich mode always draws a native table instead. */
export type TableLayout = "aligned" | "stacked";

function alignedCosts(table: MarkdownTable): { header: number; rows: number[] } {
  const widths = columnWidths(table);
  return { header: renderedRowCost(table.header, widths), rows: table.rows.map((row) => renderedRowCost(row, widths)) };
}

/** Aligned columns while every row stays within `MAX_TABLE_ROW_COST`, stacked rows otherwise. */
export function tableLayout(table: MarkdownTable): TableLayout {
  const costs = alignedCosts(table);
  return [costs.header, ...costs.rows].some((cost) => cost > MAX_TABLE_ROW_COST) ? "stacked" : "aligned";
}

/** The "Header: value" lines of one body row, empty cells left out. */
function stackedRowLines(table: MarkdownTable, row: readonly string[]): string[] {
  const lines: string[] = [];
  row.forEach((cell, column) => {
    const text = plainCell(cell);
    if (text.length > 0) {
      lines.push(`${plainCell(table.header[column] as string)}: ${text}`);
    }
  });
  return lines.length > 0 ? lines : ["(empty)"];
}

/**
 * The stacked layout: each body row is a block of "Header: value" lines, blocks separated by a blank
 * line. A table with no body rows is its header cells on one line.
 */
export function renderStackedLines(table: MarkdownTable): string[] {
  if (table.rows.length === 0) {
    return [table.header.map(plainCell).join(COLUMN_GAP).trim()];
  }
  return table.rows.flatMap((row, index) => (index === 0 ? stackedRowLines(table, row) : ["", ...stackedRowLines(table, row)]));
}

/**
 * The table as monospace lines for the text modes: aligned columns, or stacked rows when a row would
 * be too long aligned. Passing `widths` forces the aligned layout.
 */
export function renderTableLines(table: MarkdownTable, widths?: readonly number[]): string[] {
  if (widths === undefined && tableLayout(table) === "stacked") {
    return renderStackedLines(table);
  }
  const use = widths ?? columnWidths(table);
  return [table.header, ...table.rows].map((row) => renderTableRow(row, use, table.align));
}

export function renderTableText(table: MarkdownTable, widths?: readonly number[]): string {
  return renderTableLines(table, widths).join("\n");
}

/**
 * Upper bound, in UTF-16 units, of one rendered row of this table including its newline: what the
 * splitter charges for a row so a part never renders longer than the limit. The aligned layout
 * pads every cell to the column width, so it can be longer than the source row.
 */
export function renderedRowCost(cells: readonly string[], widths: readonly number[]): number {
  let cost = 1;
  cells.forEach((cell, column) => {
    const text = plainCell(cell);
    cost += text.length + Math.max(0, (widths[column] as number) - visualWidth(text));
    if (column > 0) {
      cost += COLUMN_GAP.length;
    }
  });
  return cost;
}

/**
 * What the splitter charges for the header row and for each body row. The parts are Markdown, and
 * each part is laid out again on its own, so a part of a stacked table whose rows are short may come
 * out aligned: the charge for a row of a stacked table is the larger of its stacked cost and its
 * aligned cost capped at `MAX_TABLE_ROW_COST` (an aligned part never holds a longer row), which holds
 * for either layout.
 */
export function tableCosts(table: MarkdownTable): { header: number; rows: number[] } {
  const aligned = alignedCosts(table);
  if (tableLayout(table) === "aligned") {
    return aligned;
  }
  return {
    header: Math.min(aligned.header, MAX_TABLE_ROW_COST),
    rows: table.rows.map((row, index) => {
      let stacked = 1;
      stackedRowLines(table, row).forEach((line) => {
        stacked += line.length + 1;
      });
      return Math.max(stacked, Math.min(aligned.rows[index] as number, MAX_TABLE_ROW_COST));
    }),
  };
}

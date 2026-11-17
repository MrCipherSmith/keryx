import { expect, test } from "bun:test";
import {
  SHELL_FRAME_COLUMNS,
  SHELL_FRAME_MIN_COLUMNS,
  SHELL_FRAME_MIN_ROWS,
  SHELL_FRAME_ROWS,
  SHELL_MIN_COLUMNS,
  SHELL_MIN_ROWS,
  shellFrameFits,
  shellInnerColumns,
  shellInnerRows,
} from "./shell-frame";

test("the frame takes a gutter and a border on each side", () => {
  expect(SHELL_FRAME_COLUMNS).toBe(4);
  expect(SHELL_FRAME_ROWS).toBe(2);
});

test("a roomy terminal gets the frame and loses its columns and rows to it", () => {
  expect(shellFrameFits(120, 40)).toBe(true);
  expect(shellInnerColumns(120, 40)).toBe(120 - SHELL_FRAME_COLUMNS);
  expect(shellInnerRows(40, 120)).toBe(40 - SHELL_FRAME_ROWS);
});

test("a small terminal keeps every cell: no frame below either threshold", () => {
  expect(shellFrameFits(SHELL_FRAME_MIN_COLUMNS - 1, 40)).toBe(false);
  expect(shellFrameFits(120, SHELL_FRAME_MIN_ROWS - 1)).toBe(false);
  expect(shellInnerColumns(80, 40)).toBe(80);
  expect(shellInnerColumns(120, 24)).toBe(120);
  expect(shellInnerRows(24, 120)).toBe(24);
});

test("inside the frame there is always at least the 80x24 the dialogs are fitted to", () => {
  expect(shellFrameFits(SHELL_FRAME_MIN_COLUMNS, SHELL_FRAME_MIN_ROWS)).toBe(true);
  expect(shellInnerColumns(SHELL_FRAME_MIN_COLUMNS, SHELL_FRAME_MIN_ROWS)).toBe(SHELL_MIN_COLUMNS);
  expect(shellInnerRows(SHELL_FRAME_MIN_ROWS, SHELL_FRAME_MIN_COLUMNS)).toBe(SHELL_MIN_ROWS);
});

// Flow 389 (AC2): the digest reads the flow board through a reader the product command registers,
// because the digest itself may not import the product module.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readDigestBoard } from "../commands/product";
import { readBoard, registerBoardReader } from "./digest-board";
import { copyBoardProject } from "./digest-board-project.test";

const made: string[] = [];
afterEach(async () => {
  for (const root of made.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the digest's board reader", () => {
  test("a project with an index has a board, read through the registered reader", async () => {
    const root = await copyBoardProject();
    made.push(root);
    const board = await readBoard(root);
    expect(board.failure).toBeUndefined();
    expect(board.items.length).toBeGreaterThan(0);
    expect(board.items.every((item) => item.kind === "board")).toBe(true);
    const source = await readDigestBoard(root);
    expect(source.state).toBe("present");
    if (source.state === "present") {
      expect(board.items.length).toBe(source.entries.length);
      expect(board.chains).toEqual(source.chains);
    }
  });

  test("a project with no index has a board failure that says how to build it", async () => {
    const root = await copyBoardProject({ board: false });
    made.push(root);
    const board = await readBoard(root);
    expect(board.items).toEqual([]);
    expect(board.failure?.detail).toContain("keryx product index");
  });

  test("with no reader registered the board is unavailable, not an exception", async () => {
    registerBoardReader(undefined);
    try {
      const board = await readBoard("/nonexistent-project-root");
      expect(board.items).toEqual([]);
      expect(board.failure?.source).toBe("board");
    } finally {
      registerBoardReader(readDigestBoard);
    }
  });
});

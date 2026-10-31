// Flow 389: the fixture project the digest tests run against. It holds no tests of its own
// (the board reader's are in digest-board.test.ts).
//
// The product module may be imported only by the product command, the TUI surface and the
// shell that opens it (src/product/never-gates.test.ts), and that check scans every source
// file that is not a test file. The digest's shared test support (`digest.test-helpers.ts`)
// is scanned, so it cannot name the product fixtures itself; it takes them from here.

import { readDigestBoard } from "../commands/product";
import { buildIntentIndex } from "../product/corpus";
import { copyFixtureRepo } from "../product/fixtures/repo";
import { writeIntentIndex } from "../product/store";
import { registerBoardReader } from "./digest-board";

/**
 * A throwaway project laid out from the product fixture corpus, with its product index written unless `board` is false.
 *
 * Production registers the board reader in the CLI registry; a test that does not load it gets it here, on every
 * call. The reader is one module-level slot shared by every test file in the process, and other suites clear it
 * in their teardown (`intake.test-helpers.ts`), so registering it once at import let the digest tests fail
 * whenever such a suite ran between this import and them.
 */
export async function copyBoardProject(options: { board?: boolean } = {}): Promise<string> {
  registerBoardReader(readDigestBoard);
  const root = await copyFixtureRepo();
  if (options.board !== false) await writeIntentIndex(root, await buildIntentIndex(root));
  return root;
}

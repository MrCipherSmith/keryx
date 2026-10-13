// Test preload, runner-only half: hooks that need `bun:test`, kept apart from `test-preload.ts` because
// that file is also imported by a plain `bun -e` child (test-preload.test.ts), where `beforeEach` throws.
//
// The operator-refusal memory is process-wide. Production clears it on `/clear`, `/new`, a resumed session and a
// mode change; a test has no such event, so without this a refusal in one test would reach the next test in the
// same `bun test` process (a permission-style `ask_user` menu routed to the human). Tests that need the leak to be
// visible, or the memory kept across turns, call the review-system functions themselves.

import { beforeEach } from "bun:test";
import { resetOperatorDenials } from "../review/review-system";

beforeEach(() => resetOperatorDenials());

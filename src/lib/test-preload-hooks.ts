// Test preload, runner-only half: hooks that need `bun:test`, kept apart from `test-preload.ts` because
// that file is also imported by a plain `bun -e` child (test-preload.test.ts), where `beforeEach` throws.
//
// The operator-refusal memory is process-wide and every mode records into it, so a test that refuses an approval
// would otherwise leave a refusal for the next test in the same `bun test` process (a permission-style `ask_user`
// menu routed to the human, a repeated call answered "refused earlier").

import { beforeEach } from "bun:test";
import { resetOperatorDenials } from "../review/review-system";

beforeEach(() => resetOperatorDenials());

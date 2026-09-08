// Fixture (flow 239, T8): a core owner importing a client module and using the
// binding only inside a branch that can never be taken.
//
// The binding IS referenced, so "just check whether the binding is used" would
// not save the reachability scan — the bundler folds the condition, proves the
// branch dead, and drops the module. Measured under the old check:
// `scanned=1 violations=0`.
//
// The condition is written inline on purpose. Hoisting it into a named
// `const ALWAYS_FALSE = false as boolean` was tried while building this fixture
// and does NOT reproduce the finding: Bun keeps the module in that form. The
// fixture has to be the shape that actually defeats the bundler, or it would
// assert something the reported defect never claimed.
import { CLIENT } from "../harness/leaf";

export const value = (false as boolean) ? CLIENT : "the branch above never runs";

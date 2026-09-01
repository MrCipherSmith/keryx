# Acceptance criteria

- AC1: `src/gdskills/contracts.ts` carries, per registered contract, a machine-readable
  statement of whether it is enforced in production and at which module — not prose.
  A registration that declares an enforcement point names a real non-test file.
- AC2: `review-pr-feedback-output` is refused at a keryx-owned write path. Demonstrated
  by running a payload that violates one of its conditionals (`mode: "analyze"` carrying
  a populated `fix`) through that command and observing a non-zero exit and a message
  naming the field — not by a unit test over the schema alone.
- AC3: For every contract NOT enforced in production, the reason is recorded beside its
  registration in the shape `enforcement: none` plus the sentence saying why — following
  the precedent set for `reviewer-input` in `enforcement-claims.test.ts`.
- AC4: A guard derives the enforced/unenforced split from `CONTRACTS` and fails when a
  new registration lands in neither group, so the next contract cannot join the silent
  seven by omission. Verified by adding a fake registration in-memory and observing the
  failure.
- AC5: No skill or schema in the tree claims an enforcement that AC1's table does not
  record. Verified by a sweep for the claim phrasings (`refuses a malformed one`,
  `Validate before dispatching`, `is BLOCKED`) against the recorded state.
- AC6: `bun test`, `tsc --noEmit` and `keryx skills verify --bundled` are clean, and the
  four contracts already enforced still refuse what they refused before — pinned by
  running one rejecting payload per contract.

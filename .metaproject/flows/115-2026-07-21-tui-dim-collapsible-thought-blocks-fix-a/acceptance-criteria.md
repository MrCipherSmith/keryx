# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: No runtime source under `src/tui/**` sets `alignSelf` on a renderable mounted into the transcript; a machine-checked test in `src/capability/` fails if one is reintroduced.
- AC2: In a headless mount of the shipped `createShellChrome` + `createBlockMount`, expanding a block whose body is at least 30 lines leaves every bordered box measuring at least its border rows plus one content row (no box measures below its natural height), proven by asserting measured heights rather than a frame snapshot.
- AC3: In the same mount, `scroll.scrollHeight` after expansion equals the sum of the transcript children's measured heights (no under-report), and a marker renderable added AFTER the expanded block becomes visible in `captureCharFrame()` once scrolled to the bottom.
- AC4: An expanded `thought` block renders its body through the dim chunk path, and a test distinguishes it from a `tool`/`output` block body rendered on the same frame.
- AC5: An expanded `thought` block shows at most `MAX_THOUGHT_LINES` body lines plus the hidden-line notice, while `registry.bodyText(id)` and the copy path still return the complete retained payload.
- AC6: Submitting `/think` twice through the shipped submit path expands the newest reasoning block and then collapses it, and while expanded the block header shows a hint naming how to collapse it.
- AC7: `bun run check` (tsc --noEmit + full `bun test`) passes on the branch, and `keryx health run` reports gate pass.
- AC8: `keryx memory` records the `alignSelf` height-measurement trap with the measured evidence, and flow 109's risk-R4 guidance is corrected so the idiom is not reintroduced by a future flow.

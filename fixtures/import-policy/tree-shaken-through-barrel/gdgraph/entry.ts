// Fixture (flow 239, T8): a core owner reaching a client module through a
// re-export barrel, with the binding unused.
//
// A PRECISION NOTE, because the finding as originally reported is slightly
// broader than what is true. "Barrel" alone does NOT defeat the bundler:
// written with the binding genuinely consumed (`export const used = CLIENT;`),
// this exact tree WAS reached — measured while building this fixture, the
// bundler resolved `harness/leaf.ts` straight through the barrel. What defeats
// it is the unused binding, and the barrel is a second hop the eliminated
// import happens to travel through. The fixture is therefore written the way
// the defect actually reproduces, not the way the one-word label suggests.
//
// It is still worth its own fixture, for the direct-edge side: the edge
// recorded here targets `harness/index.ts`, the barrel itself, which is ALREADY
// a client-zone module. The check does not need to follow the barrel through to
// `leaf.ts` to know the boundary was crossed — crossing it is the first hop.
import { CLIENT } from "../harness/index";

export const value = "the import above is never used";

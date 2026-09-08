// Fixture stand-in for a core owner's PUBLIC facade — named `service.ts` on
// purpose, the one basename the facade rule exempts.
//
// THIS FACADE HAS A DEPENDENCY, AND THAT IS THE POINT.
//
// It used to be a leaf (`export const serve = "core-facade";`, no imports), and
// that leafness was the only reason the "allowed" case passed under the old
// reachability-based check. A reachability set contains everything BEHIND a
// facade as well as the facade itself, so the moment a facade imports anything
// the client entry "reaches" that internal too and the check fires. No real
// facade is a leaf — `src/wiki/service.ts` and the other nine all re-export
// from internals — so the old fixture was proving a property the real tree
// could not have.
//
// Giving the fixture a realistic facade makes the allowed case fail under
// reachability and pass under direct edges, which is exactly the distinction
// this rewrite turns on.
import { detail } from "./internal";

export const serve = `core-facade:${detail}`;

// Public facade for `src/learning/` (T9/T17 concern).
//
// `src/lib/import-policy.ts`'s facade discipline recognizes exactly one
// basename per owner directory: `service.ts` ("клиент не импортирует private
// core" — a client/adapter module may reach a core owner only through this
// file, never past it into an internal module). `src/learning/index.ts`
// already IS this owner's public surface — built up task by task since T5 —
// but under a name the checker does not recognize, so every outside caller
// counted as a facade bypass (`client-imports-core-internal`) and, worse,
// made `learning` register as a FACADELESS owner (no `service.ts` at all),
// which `import-policy.live.test.ts`'s exact facadeless-owner list does not
// name.
//
// Rather than rename `index.ts` (every task's own doc comments reference it
// by that name, and mid-flow files still import `"../learning"`, which
// resolves to it), this file re-exports it unchanged under the name the
// policy looks for. Both names now serve the same content; new outside
// imports should prefer `"../learning/service"`.
export * from "./index";

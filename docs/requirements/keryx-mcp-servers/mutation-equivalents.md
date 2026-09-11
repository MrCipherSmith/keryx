# Equivalent mutants — `keryx-mcp-servers`

AC16 asks that every mutant surviving a sweep over the diff is either
killed by a new test or **recorded here with the reason it is
equivalent**. This file is the second half of that sentence.

An equivalent mutant is one whose program cannot be distinguished from
the original by any observation — not one that is merely hard to
reach, unlikely, or "obviously fine". A mutant that is hard to reach
is a gap; it belongs in a test, not in this file. Two entries below
were in the hard-to-reach category first, and moved out of it once the
code was reshaped to make the case expressible.

## P3b (flow 250) — 116 mutants over the diff

### `?? → ||` where the left operand is a function or `undefined`

| Site | Expression |
|---|---|
| `src/commands/mcp-servers.ts:437` | `deps.openBrowser ?? defaultOpenBrowser` |
| `src/commands/mcp-servers.ts:784` | `deps.connect ?? ((server) => defaultConnect(…))` |
| `src/mcp-servers/doctor.ts:272` | `options.now ?? Date.now` |
| `src/mcp-servers/oauth-callback.ts:86` | `options.serve ?? Bun.serve` |
| `src/mcp-servers/oauth-provider.ts:82` | `deps.now ?? Date.now` |
| `src/mcp-servers/runtime.ts:159` | `options.connect ?? ((server) => defaultConnect(…))` |

`??` and `||` differ only on values that are falsy but not nullish:
`0`, `""`, `false`, `NaN`, `-0`, `0n`. Each left operand above is
typed as a function or `undefined`, and **no function is falsy**, so
the two operators select the same operand for every value the type
admits. TypeScript refuses any call site that would supply one of the
distinguishing values.

Note what is NOT in this table. The same mutation on
`credentialsFile`'s `configDir ?? ensureKeryxConfigDir()` is **not**
equivalent — `""` is a string, it is falsy, and under `||` an empty
configDir silently resolves to the real credential store. That one is
a test (`credentials.table.test.ts`, "an empty configDir never
resolves to the real one"). Likewise `options.timeoutMs ?? CALLBACK_TIMEOUT_MS`,
where `0` means "do not wait" and `||` would substitute five minutes.
The operand's TYPE is what decides this, not the shape of the
expression.

### `src/mcp-servers/oauth-callback.ts:166` — deleting `if (done) return;`

The guard sits at the top of the timeout callback. Without it, a timer
that fires after the flow already completed sets `done = true` again
and calls `settle(...)` a second time.

`settle` is the `resolve` of an already-resolved promise, and **the
resolve function of a settled promise is a no-op** — the second call
cannot change the value, cannot reject it, and cannot be observed by
anything awaiting it. Setting `done` from `true` to `true` is likewise
unobservable. The guard is an early return for clarity, not for
behaviour.

### `src/mcp-servers/oauth-callback.ts:156` — `if (timer !== undefined)` → `if (timer === undefined)`

Inverted, `close()` calls `clearTimeout(undefined)` (a documented
no-op) and leaves the real timer armed.

No observation distinguishes this. The timer is `unref()`d, so it
cannot hold the process open. If it later fires, it either returns at
the `done` guard, or resolves a promise that — on this path, where
`close()` was called without the flow settling — nobody is awaiting:
`runOAuthFlow` closes in a `finally` only after it has already
returned its exit code.

This one is the weakest entry in the file. It is a leak of one timer
handle for at most the callback budget, and it is recorded here rather
than tested because the only assertion available would be on the
absence of an effect that has no observer.

## Not equivalent — corrected during triage

Recorded because getting it wrong in this direction is the dangerous
one, and I did get it wrong first.

**`src/commands/mcp-servers.ts` — `deps.interactive ?? bothStreamsAreATerminal(…)` → `||`.**
Filed as equivalent on the reasoning above, and it is not: the left
operand is `boolean | undefined`, and `false` is exactly a value where
the two operators differ. Under `||`, a caller passing
`interactive: false` on purpose falls through to the TTY probe and
gets permission instead of the refusal it asked for.

The first test written for it proved nothing: it drove the whole
command, and under `bun test` neither real stream is a TTY, so the
probe returned `false` and `false || false` is `false` — passing under
both spellings. The decision is now `resolveInteractive(explicit,
stdin, stdout)`, which takes its streams as arguments precisely so the
distinguishing case can be written down.

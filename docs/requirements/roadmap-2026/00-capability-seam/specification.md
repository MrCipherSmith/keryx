# Specification — Block 00: Capability Seam (Foundation)

Version: 1.0.0

This block introduces **no new architectural decisions**. Every contract below is the
implementation of a decision already made in `architecture.md` (§0 pattern, §2 seam, §3 assets,
§6 fixtures) constrained by `tech-bestpractices.md` (§0, §1, §7, §8). Section order follows the
project convention `DOC-3` (Purpose → Identity → Structure → Manifest → Config → CLI → Service
Contract → Actions → Schema → Integration → Hooks → Standard Profile → Acceptance → Phases → Open
Questions), adapted for a substrate that ships no end-user module.

## 1. Purpose

Provide the **single, project-wide opt-in substrate** every Block A–E instantiates: a uniform
Capability Seam (`resolveCapability(id) → Adapter | null`), the `optionalDependencies` + lazy-import
dependency policy, the shared Asset Resolver (checksum-verified, network only on explicit pull),
and the reusable fixture-corpora acceptance harness with a false-negative-rate gate. It generalizes
the proven `security.backends` idiom (`src/security/config.ts`, `src/security/guard.ts`) into a
reusable seam. It ships **no end-user feature**.

## 2. Identity

- **Not a user-facing module.** It is cross-cutting infrastructure, peer to the way `standard/` and
  `security/guard.ts` span modules. It has **no** `metaproject.json` module entry of its own;
  instead it defines the *shape* of the `capabilities` entries other modules use.
- **Dependency direction (invariant, arch §1)**: `cli → commands → services → lib`. The seam +
  resolver + harness live in shared locations reachable by services; adapters live **beside their
  service** and are the only place an optional dep is imported.

## 3. Structure

```
src/
  capability/
    seam.ts          # resolveCapability(), CapabilityAdapter<In,Out>, registry types
    seam.test.ts     # available / unavailable / adapter-never-throws
    warn-once.ts     # process-scoped warn-once helper (stderr)
  assets/
    resolver.ts      # resolveAsset(cfg, id) → { path, sha256, verified } | null
    lock.ts          # read/verify/update assets.lock.json
    pull.ts          # the ONLY network path (used by `<module> assets pull`)
    resolver.test.ts
  harness/
    corpus.ts        # load fixtures/<corpus>/, run a detector/selector, compute FN/precision/recall
    gate.ts          # CI-gating entry: fail on FN-rate regression beyond threshold
    corpus.test.ts

  <module>/<cap>/adapter.ts   # per-capability adapter (imports the optional dep here ONLY)

fixtures/<corpus>/              # committed labeled corpora (per block; §9 harness convention)
.metaproject/assets.lock.json  # committed pinned asset registry (id/version/url/sha256/size)
```

Rules: `src/capability/`, `src/assets/`, `src/harness/` import only `lib/*` + Node builtins — never
a module's internals (keeps them acyclic, mirroring `security/guard.ts`). No top-level `import` of
any optional dependency exists anywhere in `src/` (`C0-2`).

## 4. Manifest Entry (capability shape other modules use)

A capability is declared inside its owning module's existing `metaproject.json` entry, reusing the
`capabilities[]` array already present (see `src/standard/capabilities.ts`,
`extractCapabilities`). Ceilings default OFF; a missing manifest = capability off (`C0-9`, mirrors
`isSecurityEnabled`).

```json
{
  "modules": {
    "gdgraph": {
      "enabled": true,
      "commands": ["build", "query", "affected", "repomap"],
      "capabilities": [
        {
          "id": "gdgraph.treesitter",
          "enabled": false,
          "kind": "ceiling",
          "optionalDependency": "web-tree-sitter",
          "asset": "treesitter-grammars",
          "config": ".metaproject/gdgraph.config.json"
        }
      ]
    }
  }
}
```

Back-compat: a capability MAY also be a bare string (`"gdgraph.treesitter"`) as today; the object
form above is the enriched shape the seam reads. `extractCapabilities` continues to accept both.

Capability-entry JSON schema (draft):

```json
{
  "$id": "capability-entry.schema.json",
  "type": "object",
  "required": ["id", "enabled", "kind"],
  "properties": {
    "id":   { "type": "string", "pattern": "^[a-z0-9-]+\\.[a-z0-9-]+$" },
    "enabled": { "type": "boolean" },
    "kind": { "enum": ["floor", "ceiling"] },
    "optionalDependency": { "type": "string" },
    "asset": { "type": "string" },
    "config": { "type": "string" }
  },
  "additionalProperties": false
}
```

## 5. Config

Per-module config carries the capability toggle, deep-merged over defaults, falling back to
defaults on malformed JSON (`C0-8`, mirrors `mergeSecurityConfig`/`loadSecurityConfig`). Example
(`gdgraph.config.json`); the shape is uniform across modules:

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "treesitter": {
      "enabled": false,
      "grammarsPath": null,
      "asset": "treesitter-grammars"
    }
  }
}
```

`assets.lock.json` (committed, `A-4`) — the pinned asset registry the resolver verifies against:

```json
{
  "schemaVersion": 1,
  "assets": {
    "treesitter-grammars": {
      "version": "0.22.0",
      "url": "https://<pinned-host>/grammars-0.22.0.tar.gz",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "size": 1048576
    }
  }
}
```

Asset registry entry as read at runtime (config or lock): `{ id, path?, url?, sha256, size }`
(arch §3).

## 6. CLI

The seam adds **no top-level command**. Each opt-in module gains a uniform `assets` subcommand
(the sole network surface, `A-6`):

```bash
gd-metapro <module> assets list                 # show declared assets + resolution state
gd-metapro <module> assets verify [<id>]        # re-check sha256 of resolved asset(s); network-free
gd-metapro <module> assets pull <id>            # THE ONLY network path: fetch pinned url, verify
                                                #   sha256 against assets.lock.json, refuse on mismatch
```

`init`/`update` gain the uniform capability flags:

```bash
gd-metapro init   --<cap> | --no-<cap>          # ceilings default OFF; writes manifest + config
gd-metapro update                               # reconciles new capabilities without disabling modules
```

## 6a. Service Contract (in-process)

The seam is used as an in-process library, not only via CLI. Uniform shape (arch §2.2):

```ts
// src/capability/seam.ts
export interface CapabilityAdapter<In, Out> {
  readonly id: string;                 // e.g. "gdgraph.treesitter"
  isAvailable(): Promise<boolean>;     // dep importable AND asset resolved+verified
  run(input: In): Promise<Out>;        // called ONLY when isAvailable() resolved true
}

export interface CapabilitySpec<In, Out> {
  readonly id: string;
  readonly optionalDependency?: string;   // module specifier for `await import()`
  readonly asset?: string;                // asset id resolved via resolveAsset()
  // Factory: given the imported dep + resolved asset, build the adapter.
  load(ctx: { dep: unknown; asset: { path: string } | null }): CapabilityAdapter<In, Out>;
}

// Returns an adapter ONLY when: manifest capability enabled
//   AND (optionalDependency importable, if declared)
//   AND (asset resolved+verified, if declared).
// Returns null the instant any of these fails → the caller runs its deterministic fallback.
// NEVER throws (all failures are caught and mapped to null / warn-once).
export async function resolveCapability<In, Out>(
  cwd: string,
  spec: CapabilitySpec<In, Out>,
): Promise<CapabilityAdapter<In, Out> | null>;
```

Reference call site (every block follows this exact shape):

```ts
const cap = await resolveCapability(cwd, treesitterSpec);
const graph = cap
  ? await cap.run(files).catch(() => buildRegexGraph(files))  // adapter error → fallback (C0-11)
  : buildRegexGraph(files);                                    // null → deterministic path (XP2)
```

Asset Resolver contract (arch §3):

```ts
// src/assets/resolver.ts
export interface ResolvedAsset { path: string; sha256: string; verified: boolean; }

// T1 user-path (config field) | T2 pulled (assets.lock.json) | T3 well-known cache
//   ~/.cache/gd-metapro/assets/<id>. Verifies sha256 on EVERY load.
// Returns null when missing OR unverified. NEVER initiates a network call.
export async function resolveAsset(
  cfg: AssetRegistry,
  id: string,
): Promise<ResolvedAsset | null>;

// The ONLY function that touches the network. Used solely by `<module> assets pull`.
export async function pullAsset(id: string, lock: AssetsLock): Promise<ResolvedAsset>; // verify or throw
```

Fixture harness contract (arch §6, generalizes E6):

```ts
// src/harness/corpus.ts
export interface CorpusCase { id: string; input: string; expected: "positive" | "negative"; }
export interface DetectorFn { (input: string): Promise<boolean> | boolean; }
export interface CorpusReport {
  corpus: string; total: number;
  truePos: number; falseNeg: number; falsePos: number; trueNeg: number;
  fnRate: number; precision: number; recall: number;   // deterministic, re-runnable
}

export async function runCorpus(dir: string, detect: DetectorFn): Promise<CorpusReport>;

// src/harness/gate.ts — CI entry: fail (non-zero) when fnRate regresses beyond threshold.
export async function gateCorpus(
  report: CorpusReport,
  opts: { maxFnRate: number },
): Promise<{ status: "pass" | "fail"; reasons: string[] }>;
```

## 7. Actions (graceful-degradation contract — binding on every block)

Per architecture §2.3; these are the states the seam guarantees:

1. **Disabled in manifest** ⇒ deterministic path; no dep loaded, no asset touched (`C0-4`).
2. **Enabled but dep not installed / asset missing / checksum fails** ⇒ **warn once (stderr)**,
   run deterministic fallback, **exit 0** (`C0-5`). Never hard-fail.
3. **Adapter throws at runtime** ⇒ caught, degrade to deterministic result (`C0-11`; mirrors
   `analyze()`/`guardOutput` try/catch → allow).
4. **Enabling a ceiling** must never change the default artifact's reproducibility (`XP4`).

The one sanctioned exception (arch §4.1): `gd-metapro mcp serve` (Group A) MAY hard-require its SDK
because the operator explicitly asked to run a server. This block only defines the exception's
shape; it does not implement `mcp`.

## 8. Schema Summary

- `capability-entry.schema.json` — §4 above.
- `assets.lock.json` — §5 above; committed (`A-4`), pinned `{ version, url, sha256, size }` per id.
- `CorpusReport` — §6a; the harness output, deterministic and diffable.

## 9. Integration Points

- **`init` / `update` (`src/commands/init.ts`, `update.ts`)**: register capability flags, write the
  manifest `capabilities[]` entry + module config (US-007). `update` reconciles new capabilities
  without disabling already-enabled modules (mirrors existing `moduleEnabled` reconciliation).
- **Every Block A–E service**: calls `resolveCapability()` and provides its deterministic fallback
  (`C0-6`). No service imports an optional dep directly (`C0-14`).
- **`security/guard.ts:redactRaw`**: unchanged; Group A/E reuse it. Block 0 does not modify it.
- **Fixture convention (`F-1`)**: each corpus lives at `fixtures/<corpus>/`, is committed and
  deterministic (`F-2`); each block PRD names its corpus as the acceptance gate. The harness here is
  the shared runner.

## 10. Hooks

No new git/agent hooks. `C0-12`: **MUST NOT** add a `postinstall` that downloads assets or deps —
this is an explicit anti-requirement of this block.

## 11. Standard Profile

The `capabilities[]` object shape (§4) is additive to the Metaproject Standard's module descriptor
and is emitted by `extractCapabilities`. Repositioning of the Standard as a *generator* is Group A
(G-A3), out of scope here; Block 0 only makes the capability shape standard-representable.

## 12. Acceptance

Gated by `acceptance-criteria.md`. The block-level acceptance artifact (arch §6 / `F-1`) is the
**harness self-test against a seed fixture** plus the **no-network sandbox test** — Block 0 has no
capability-metric fixture of its own because it ships no detector; it ships the *machinery* A–E use.

## 13. Phases

1. **Seam core** — `resolveCapability` + `CapabilityAdapter` + warn-once; unit tests
   (available/unavailable/never-throws).
2. **Dependency policy** — empty `dependencies`, `optionalDependencies` declared, lint/guard against
   top-level optional imports; no-network sandbox test.
3. **Asset Resolver** — `resolveAsset` + `assets.lock.json` + `<module> assets list/verify/pull`;
   checksum-verify + refuse-on-mismatch tests.
4. **Fixture harness** — `runCorpus` + `gateCorpus`; self-test on seed fixture.
5. **init/update wiring** — uniform capability flags + manifest/config registration + reconciliation.
6. **Reference capability** — one end-to-end capability (availability-true + availability-false)
   proving the seam, without shipping an end-user feature.

## 14. Open Questions

- **OQ-1**: Final home of `src/capability/`, `src/assets/`, `src/harness/` vs folding into
  `src/lib/` — must preserve `cli → commands → services → lib` direction.
- **OQ-2**: Manifest `modules.<m>.capabilities[]` object form vs a top-level `capabilities` block
  (arch §2.1 leaves both open); recommended: reuse `modules.<m>.capabilities[]`.
- **OQ-3**: Whether the reference capability in Phase 6 is a throwaway fixture or the first real
  slice of Block B's `gdgraph.treesitter` (recommended: a throwaway so Block 0 ships no feature,
  per NG0-1).

Review of PR #810 (flow 373): aliases are resolved only at entry points and cannot make a disabled agent runnable; one major gap (a disable not revoking a live hook) and three minor notes.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow373-pr810-review",
    "severity": "major",
    "problem": "createLazyRunExternal cached an AVAILABLE hook for the life of the closure together with the config and manifest snapshot taken at first resolution, so `/external-agents off` or `keryx agents external disable` did not revoke later spawn_subagent dispatches in the same shell session. It is the mirror of the enable case the PR fixes.",
    "impact": "After the operator turns external agents off, a model-issued spawn_subagent could still reach an external agent until the shell restarted: the new disable command silently failed to revoke.",
    "suggested_fix": "Re-run the capability gate on every dispatch (one config read plus one manifest read) instead of caching, and test that disable revokes the next call.",
    "evidence": "Read src/harness/run-external-factory.ts createLazyRunExternal: only the unavailable result was uncached; `resolved ??= resolveHook()` kept the hook. Fixed in commit 19f1479d with a test that enables, dispatches, disables and expects Denied.",
    "confidence": "high",
    "file": "src/harness/run-external-factory.ts",
    "line": 571,
    "quote": "    resolved ??= resolveHook();",
    "class_scope": {"sites": ["src/harness/run-external-factory.ts"], "enumeration_method": "keryx ctx rg for createLazyRunExternal and createRunExternal across src; createLazyRunExternal is the only place that caches the resolved hook across dispatches"}
  },
  {
    "id": "F-002",
    "reviewer": "flow373-pr810-review",
    "severity": "minor",
    "problem": "The alias table was a plain object literal, so `constructor` or `__proto__` returned an inherited non-string and `??` did not fall through to the typed input.",
    "impact": "A model-supplied runtime.agent of `constructor` could make canonicalExternalAgentId return a function and reach the vendor gates as a non-string.",
    "suggested_fix": "Use Object.hasOwn before reading the table, and test the prototype keys.",
    "evidence": "Read src/harness/external/registry.ts canonicalExternalAgentId. Fixed in commit 19f1479d with tests for constructor, __proto__ and toString.",
    "confidence": "high",
    "file": "src/harness/external/registry.ts",
    "line": 155,
    "quote": "  return EXTERNAL_AGENT_ALIASES[input.trim().toLowerCase()] ?? input;"
  },
  {
    "id": "F-003",
    "reviewer": "flow373-pr810-review",
    "severity": "minor",
    "problem": "toggleManifestEntry re-serialises the manifest with JSON.stringify, so the change is semantic rather than byte-wise: integer-like keys reorder, integers above 2^53 lose precision, CRLF becomes LF, a minified file expands, duplicate keys collapse.",
    "impact": "A hand-edited, git-tracked manifest can get a noisy diff on enable or disable. The manifest is written by keryx itself and is pretty-printed JSON; invalid JSON is never overwritten and the file mode is kept.",
    "suggested_fix": "Acceptable as is; a text-level patch of the one boolean would avoid it if hand-edited manifests turn out to matter.",
    "evidence": "Read src/capability/external-agents.ts toggleManifestEntry: indent and trailing newline are preserved, nothing else is.",
    "confidence": "high",
    "file": "src/capability/external-agents.ts",
    "line": 631,
    "quote": "  const next = `${JSON.stringify(parsed, null, indent)}${text.endsWith(\"\\n\") ? \"\\n\" : \"\"}`;"
  },
  {
    "id": "F-004",
    "reviewer": "flow373-pr810-review",
    "severity": "minor",
    "problem": "/external-agents is not on the busy allow-list, so typed during a main turn it is deferred until the turn ends, while /delegate is allowed.",
    "impact": "An `off` typed mid-run applies after the turn, not immediately. Same behaviour as /external.",
    "suggested_fix": "None needed: a capability change during a live turn applying at the turn boundary is the existing rule for /external.",
    "evidence": "Read src/tui/busy-dispatch.ts; the subagent reviewer could not see the tui-shell dispatch site.",
    "confidence": "medium",
    "file": "src/tui/busy-dispatch.ts",
    "line": 1,
    "quote": "busy"
  }
]
```

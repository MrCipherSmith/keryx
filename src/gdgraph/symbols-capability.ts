// Enable/disable the `gdgraph.treesitter` capability in a parsed
// `metaproject.json` — the opt-in switch for the symbol layer. Pure manifest
// transforms (the command layer owns file IO), merge-safe: preserves any other
// gdgraph capabilities and never rewrites unrelated modules.

export const TREESITTER_CAPABILITY = "gdgraph.treesitter";

type Json = Record<string, unknown>;

function treesitterEntry(enabled: boolean): Json {
  return {
    id: TREESITTER_CAPABILITY,
    enabled,
    kind: "ceiling",
    optionalDependency: "web-tree-sitter",
  };
}

// Return a new manifest with the gdgraph.treesitter capability set to `enabled`,
// adding the gdgraph module capabilities array if absent. Other capabilities and
// modules are preserved untouched.
export function setTreesitterEnabled(manifest: Json, enabled: boolean): Json {
  const modules =
    typeof manifest.modules === "object" && manifest.modules !== null
      ? { ...(manifest.modules as Json) }
      : {};
  const gdgraph =
    typeof modules.gdgraph === "object" && modules.gdgraph !== null
      ? { ...(modules.gdgraph as Json) }
      : {};

  const existing = Array.isArray(gdgraph.capabilities) ? (gdgraph.capabilities as unknown[]) : [];
  const others = existing.filter(
    (c) => !(c && typeof c === "object" && (c as Json).id === TREESITTER_CAPABILITY),
  );
  gdgraph.capabilities = [...others, treesitterEntry(enabled)];
  modules.gdgraph = gdgraph;
  return { ...manifest, modules };
}

// Whether the manifest has gdgraph.treesitter enabled.
export function isTreesitterEnabled(manifest: Json): boolean {
  const modules = manifest.modules as Json | undefined;
  const gdgraph = modules?.gdgraph as Json | undefined;
  const caps = Array.isArray(gdgraph?.capabilities) ? (gdgraph?.capabilities as unknown[]) : [];
  return caps.some(
    (c) => c && typeof c === "object" && (c as Json).id === TREESITTER_CAPABILITY && (c as Json).enabled === true,
  );
}

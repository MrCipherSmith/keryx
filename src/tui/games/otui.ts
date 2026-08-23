// Structural OpenTUI access for the games modal + agent panel.
// `@opentui/core` is an OPTIONAL dependency (ADR-0005): referenced only via
// `typeof import(...)`, never imported at top level.
//
// asOtui narrows an `unknown` runtime value (the shell's `otui` handle) to
// the two renderable constructors the games actually use. Everything else the
// host needs comes from the shell's own `chrome`/`renderer` objects.

type OpenTui = typeof import("@opentui/core");
export type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
export type Box = InstanceType<OpenTui["BoxRenderable"]>;
export type Text = InstanceType<OpenTui["TextRenderable"]>;

export type OtuiLike = {
  BoxRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Box;
  TextRenderable: new (renderer: Renderer, opts: Record<string, unknown>) => Text;
};

export function asOtui(otui: unknown): OtuiLike | undefined {
  if (otui === undefined || otui === null) {
    return undefined;
  }
  const cand = otui as Partial<OtuiLike>;
  if (cand.BoxRenderable === undefined || cand.TextRenderable === undefined) {
    return undefined;
  }
  return cand as OtuiLike;
}

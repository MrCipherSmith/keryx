// OpenTUI interactive agent shell — Phase 1 renderer skeleton (flow 060).
//
// A new IO implementation of the existing `AgentIO` hook surface (src/commands/
// agent.ts): it appends PLAIN-TEXT blocks to an OpenTUI transcript and drives
// `runAgentTurn` from a `split-footer` composer (a fixed footer input over a
// scrolling main region — the Pi/grok layout). The deterministic driver and the
// pure render helpers are unchanged; markdown / gutter / tool-collapse / reasoning
// chrome parity is Phase 2.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005) loaded ONLY via a dynamic
// `import()` — never a top-level import (keryx's zero-`dependencies` floor + lazy
// optional-import guard, src/capability/no-optional-imports). `launchTuiAgentShell`
// is defensive: it returns `false` (caller falls back to the readline shell)
// whenever there is no TTY, the package is absent, or the renderer fails to init.
import type { AgentDeps, AgentIO } from "../commands/agent";
import { runAgentTurn } from "../commands/agent";
import type { NormalizedMessage } from "../harness/provider/types";

/** The `@opentui/core` module shape, referenced structurally (type-only import). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

/**
 * Build an `AgentIO` that renders into an OpenTUI `transcript` box as plain text.
 * Streamed tokens (`write`) accumulate into an active `TextRenderable`; each other
 * hook appends a labelled block. Exported so the headless test can drive the same
 * render path through `runAgentTurn` without a real TTY.
 */
export function createTuiAgentIo(otui: OpenTui, renderer: Renderer, transcript: Box): AgentIO {
  let seq = 0;
  let active: Text | undefined;
  let pending = "";
  const append = (content: string): void => {
    transcript.add(new otui.TextRenderable(renderer, { id: `n${seq++}`, content }));
  };
  return {
    write: (s) => {
      if (s.length === 0) {
        return;
      }
      pending += s;
      if (active === undefined) {
        active = new otui.TextRenderable(renderer, { id: `a${seq++}`, content: pending });
        transcript.add(active);
      } else {
        active.content = pending;
      }
    },
    onAssistantText: (text) => {
      if (active !== undefined) {
        active.content = text;
        active = undefined;
      } else {
        append(text);
      }
      pending = "";
    },
    onReasoning: (text) => append(`⋯ thinking\n${text}`),
    onUsage: () => {
      // Phase 2 renders the token line; the skeleton drops it.
    },
    onToolCall: (name, input) => append(`⚙ ${name}(${input})`),
    onToolResult: (_name, result) => append(`↳ ${result.output.split("\n")[0] ?? ""}`),
    onSystem: (text) => append(text),
  };
}

/**
 * Attempt the OpenTUI agent shell. Returns `true` if it ran to completion (user
 * exited), `false` if it declined/failed and the caller should fall back to the
 * readline shell. Never throws.
 */
export async function launchTuiAgentShell(deps: AgentDeps): Promise<boolean> {
  if (!process.stdout.isTTY) {
    return false;
  }
  let otui: OpenTui;
  try {
    otui = await import("@opentui/core"); // optional dep; absent → fall back
  } catch {
    return false;
  }

  let renderer: Renderer | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  try {
    // Stable non-nullable handle for the closures below (the outer `renderer`
    // stays `Renderer | undefined` for the `finally` teardown).
    const r = (renderer = await otui.createCliRenderer({
      exitOnCtrlC: true,
      screenMode: "split-footer",
      onDestroy: () => resolveDone(),
    }));
    const transcript = new otui.BoxRenderable(r, {
      id: "transcript",
      flexGrow: 1,
      flexDirection: "column",
      padding: 1,
    });
    r.root.add(transcript);
    transcript.add(
      new otui.TextRenderable(r, {
        id: "header",
        content: "keryx — agent (OpenTUI) · type a task · Ctrl+C to exit",
      }),
    );

    const io = createTuiAgentIo(otui, r, transcript);
    const input = new otui.InputRenderable(r, { id: "prompt", placeholder: "type a task…" });
    r.root.add(input);
    input.focus();

    const history: NormalizedMessage[] = [];
    let uid = 0;
    let busy = false;
    input.on(otui.InputRenderableEvents.ENTER, () => {
      if (busy) {
        return; // one turn at a time
      }
      const line = input.value.trim();
      input.value = "";
      if (line.length === 0) {
        return;
      }
      if (line === "/exit" || line === "/quit") {
        r.destroy();
        return;
      }
      transcript.add(new otui.TextRenderable(r, { id: `u${uid++}`, content: `❯ ${line}` }));
      busy = true;
      void runAgentTurn(io, deps, history, line).finally(() => {
        busy = false;
      });
    });

    await done;
    return true;
  } catch {
    return false;
  } finally {
    try {
      renderer?.destroy();
    } catch {
      // best-effort teardown
    }
  }
}

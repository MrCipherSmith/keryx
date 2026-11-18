// The title bar's Project menu: keryx init / update, the wiki commands, and wiki enrich (its own dialog).

import { useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { commandLine, PROJECT_COMMANDS } from "./projectCommands";
import type { RunProjectCommand } from "./useProjectRunner";

export function ProjectMenu({ run, onEnrich }: { run: RunProjectCommand; onEnrich: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const entry = (c: (typeof PROJECT_COMMANDS)[number]): MenuItem => ({
    id: c.id,
    label: c.label,
    description: <span className="mono truncate">{commandLine(c.args)}</span>,
    icon: c.group === "Wiki" ? "file" : "play",
    onSelect: () => void run(c.args, `keryx ${c.args.join(" ")}`),
  });
  const items: MenuItem[] = [
    { kind: "header", id: "h-project", label: "Project" },
    ...PROJECT_COMMANDS.filter((c) => c.group === "Project").map(entry),
    { kind: "separator", id: "s-wiki" },
    { kind: "header", id: "h-wiki", label: "Wiki" },
    ...PROJECT_COMMANDS.filter((c) => c.group === "Wiki").map(entry),
    { kind: "separator", id: "s-enrich" },
    { id: "wiki-enrich", label: "Wiki enrich…", description: "Fill draft pages with a model: one job or waves", icon: "wand", onSelect: onEnrich },
  ];
  return (
    <>
      <button
        ref={btn}
        className="palette-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Run keryx init, update and wiki commands in a terminal tab"
      >
        <Icon name="play" size={13} />
        <span>Run</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? <Menu anchor={btn.current} items={items} onClose={() => setOpen(false)} label="Project commands" width={340} /> : null}
    </>
  );
}

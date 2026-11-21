// The title bar’s Project menu opens setup, wiki maintenance and wiki enrich.

import { useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { commandLine, PROJECT_COMMANDS } from "./projectCommands";
import type { RunProjectCommand } from "./useProjectRunner";

export function ProjectMenu({ run, onSetup, onEnrich }: { run: RunProjectCommand; onSetup: () => void; onEnrich: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const entry = (c: (typeof PROJECT_COMMANDS)[number]): MenuItem => ({
    id: c.id,
    label: c.label,
    description: <span className="mono truncate">{commandLine(c.args)}</span>,
    icon: "file",
    onSelect: () => void run(c.args, `keryx ${c.args.join(" ")}`),
  });
  const items: MenuItem[] = [
    { kind: "header", id: "h-project", label: "Project" },
    { id: "project-setup", label: "Set up Metaproject…", icon: "settings", onSelect: onSetup },
    { kind: "separator", id: "s-wiki" },
    { kind: "header", id: "h-wiki", label: "Wiki" },
    ...PROJECT_COMMANDS.map(entry),
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
        title="Project setup and wiki commands"
      >
        <Icon name="play" size={13} />
        <span>Run</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? <Menu anchor={btn.current} items={items} onClose={() => setOpen(false)} label="Project commands" width={340} /> : null}
    </>
  );
}

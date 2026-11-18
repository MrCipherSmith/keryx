import { useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useEscape, useFocusTrap } from "../components/ui";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon: IconName;
  hint?: ReactNode;
  run: () => void;
}

function score(item: PaletteItem, q: string): number {
  if (!q) return 1;
  const hay = `${item.label} ${item.detail ?? ""} ${item.group}`.toLowerCase();
  const label = item.label.toLowerCase();
  if (label.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  // every word of the query appears somewhere
  return q.split(/\s+/).every((w) => hay.includes(w)) ? 1 : 0;
}

export function CommandPalette({ items, onClose, initialQuery = "" }: { items: PaletteItem[]; onClose: () => void; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useFocusTrap(box);
  useEscape(onClose);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .map((it, i) => ({ it, s: score(it, needle), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 60)
      .map((x) => x.it);
  }, [items, q]);

  const choose = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  const move = (d: number) => {
    setSel((s) => {
      const n = (s + d + results.length) % Math.max(results.length, 1);
      list.current?.querySelector<HTMLElement>(`[data-index="${n}"]`)?.scrollIntoView({ block: "nearest" });
      return n;
    });
  };

  let lastGroup = "";
  return (
    <div className="overlay overlay-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            data-autofocus
            value={q}
            placeholder="Type a command, a session, a project or /slash"
            aria-label="Search commands"
            aria-controls="palette-list"
            aria-activedescendant={results[sel] ? `pal-${results[sel]!.id}` : undefined}
            role="combobox"
            aria-expanded="true"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[sel]);
              }
            }}
          />
        </div>
        <ul ref={list} id="palette-list" className="palette-list" role="listbox">
          {results.length === 0 ? <li className="palette-empty">Nothing matches “{q}”</li> : null}
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.id} role="presentation">
                {header ? <div className="palette-group">{header}</div> : null}
                <div
                  id={`pal-${it.id}`}
                  role="option"
                  aria-selected={i === sel}
                  data-index={i}
                  className={`palette-item${i === sel ? " is-sel" : ""}`}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={() => choose(it)}
                >
                  <Icon name={it.icon} size={15} />
                  <span className="palette-label truncate">{it.label}</span>
                  {it.detail ? <span className="palette-detail truncate">{it.detail}</span> : null}
                  {it.hint ? <span className="palette-hint">{it.hint}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="palette-foot">
          <span>↑↓ to move</span>
          <span>↵ to run</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}

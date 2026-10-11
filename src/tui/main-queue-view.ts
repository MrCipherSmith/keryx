// The renderables of the main-queue panel: one row per queued message (text, state, wait reason,
// Force/Edit/Delete) and the single line that explains [Force]. Split from `tui-shell.ts` so the
// panel can be rendered headless with an approval pending (flow 426, AC6).

import { smallActionButton } from "./action-button";
import { formatQueueRow, QUEUE_FORCE_HELP, type QueueWait } from "./main-queue";
import { getTheme } from "./theme";
import { dimChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;

export type MainQueueRowButtons = Record<"force" | "edit" | "delete", { box: Box; setActive: (active: boolean) => void }>;

export interface MainQueueRowParams {
  id: string;
  index: number;
  text: string;
  wait: QueueWait;
  onForce: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function buildMainQueueRow(
  otui: OpenTui,
  r: Renderer,
  params: MainQueueRowParams,
): { box: Box; buttons: MainQueueRowButtons; setRowActive: (active: boolean) => void } {
  const theme = getTheme();
  const row = new otui.BoxRenderable(r, { id: `mq-${params.id}`, width: "100%", flexDirection: "row" });
  row.add(
    new otui.TextRenderable(r, {
      id: `mq-${params.id}-t`,
      flexGrow: 1,
      minWidth: 0,
      content: otui.t`${dimChunk(otui, formatQueueRow(params.index, params.text, params.wait))}`,
    }),
  );
  const force = smallActionButton(otui, r, "Force", `mq-force-${params.id}`, theme.focus, params.onForce);
  const edit = smallActionButton(otui, r, "Edit", `mq-edit-${params.id}`, theme.text, params.onEdit);
  const del = smallActionButton(otui, r, "Delete", `mq-del-${params.id}`, theme.error, params.onDelete);
  row.add(force.box);
  row.add(edit.box);
  row.add(del.box);
  return {
    box: row,
    buttons: { force, edit, delete: del },
    setRowActive: (active) => {
      row.backgroundColor = active ? theme.highlight : undefined;
    },
  };
}

export function buildMainQueueHelp(otui: OpenTui, r: Renderer): Text {
  return new otui.TextRenderable(r, {
    id: "mq-help",
    width: "100%",
    content: otui.t`${dimChunk(otui, QUEUE_FORCE_HELP)}`,
  });
}

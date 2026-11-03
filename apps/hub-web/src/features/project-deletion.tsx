import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage, getJson, postJson } from "../api/client";
import type { Project } from "../api/types";
import { Button, Field, Input, Notice } from "../components/ui";
import { useHub } from "../app/hub-context";

const descriptions: Record<string, [string, string]> = {
  "open-flows": ["Закройте открытые Flow.", "Close the open Flows."],
  machines: ["Отвяжите машины и отмените действующие подключения.", "Detach machines and cancel pending pairings."],
  sessions: ["Закройте активные сессии.", "Close active sessions."],
  "unfinished-work": ["Завершите ожидающие решения, доставки и запуски.", "Resolve pending decisions, deliveries, and runs."],
  "retained-history": ["Проект содержит данные или историю. Удаление доступно для пустых проектов.", "This project has data or history. Only empty projects can be deleted."],
};

export function ProjectDeletion({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const { scopeKey } = useHub();
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith("ru");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const path = "/projects/" + encodeURIComponent(project.id) + "/deletion";
  const preview = useQuery({
    queryKey: [scopeKey, project.id, "deletion"],
    queryFn: ({ signal }) => getJson<{ project: Project; blockers: string[] }>(path, signal),
    enabled: open,
  });
  const remove = useMutation({
    mutationFn: () => postJson(path, { name, expectedVersion: preview.data?.project.version }),
    onSuccess: onDeleted,
    onError: () => void preview.refetch(),
  });
  return (
    <section className="mt-6">
      {!open ? (
        <Button variant="secondary" onClick={() => { setOpen(true); void preview.refetch(); }}>
          {ru ? "Удалить проект" : "Delete project"}
        </Button>
      ) : (
        <form className="space-y-3" onSubmit={event => {
          event.preventDefault();
          if (preview.data?.blockers.length === 0 && name === project.name && !remove.isPending && !preview.isFetching) remove.mutate();
        }}>
          <Notice tone="error">{ru ? `Проект «${project.name}» будет удалён из Hub. Это действие необратимо.` : `“${project.name}” will be permanently removed from Hub.`}</Notice>
          {preview.isFetching ? <p role="status">{ru ? "Проверяем проект…" : "Checking the project…"}</p> : null}
          {preview.error || remove.error ? <Notice tone="error">{errorMessage(preview.error ?? remove.error)}</Notice> : null}
          {preview.data?.blockers.map(code => <p key={code}>{descriptions[code]?.[ru ? 0 : 1] ?? code}</p>)}
          {preview.data?.blockers.length === 0 ? (
            <Field label={ru ? "Введите имя проекта для подтверждения" : "Type the project name to confirm"}>
              <Input value={name} onChange={event => setName(event.target.value)} autoComplete="off" />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={preview.data?.blockers.length !== 0 || name !== project.name || preview.isFetching || remove.isPending}>
              {ru ? "Подтвердить удаление" : "Confirm deletion"}
            </Button>
            <Button type="button" variant="secondary" disabled={remove.isPending} onClick={() => { setOpen(false); setName(""); remove.reset(); }}>
              {ru ? "Отмена" : "Cancel"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

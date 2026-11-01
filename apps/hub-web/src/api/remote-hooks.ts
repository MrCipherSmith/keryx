import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHub } from "../app/hub-context";
import { remoteGet, remoteMutate, remoteProject } from "./remote";
import {
  InvalidationWindow,
  InvalidationBatch,
  parseInvalidation,
} from "./browser-invalidations";
import { ApiError, invalidateAuthentication } from "./client";
export function useRemoteQuery<T>(
  key: readonly unknown[],
  path: string,
  enabled = true,
) {
  const { scopeKey, projectId } = useHub();
  return useQuery({
    queryKey: [scopeKey, projectId, "remote", ...key],
    queryFn: ({ signal }) => remoteGet<T>(path, signal),
    enabled: !!projectId && enabled,
  });
}
export function useRemoteAction<T = unknown>() {
  const { scopeKey, projectId } = useHub();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      path,
      body,
      method = "POST",
    }: {
      path: string;
      body: unknown;
      method?: "POST" | "PUT" | "PATCH" | "DELETE";
    }) => remoteMutate<T>(method, path, body),
    retry: false,
    onSuccess: () =>
      client.invalidateQueries({ queryKey: [scopeKey, projectId, "remote"] }),
  });
}
export const sessionPath = (p: string, s: string) =>
  remoteProject(p) + "/sessions/" + encodeURIComponent(s);
export function useRemoteEvents(authorizedProjectIds: readonly string[] = []) {
  const { scopeKey, projectId } = useHub();
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const global = projectId === null;
  const projectKey = JSON.stringify(
    projectId ? [projectId] : [...new Set(authorizedProjectIds)].sort(),
  );
  useEffect(() => {
    setConnected(false);
    const ids = JSON.parse(projectKey) as string[];
    if (!ids.length || typeof WebSocket === "undefined") return;
    let active = true;
    const opened = new Set<string>();
    const cleanups = ids.map((id) => {
      let socket: WebSocket | undefined;
      let reconnect: ReturnType<typeof setTimeout> | undefined;
      let coalesce: ReturnType<typeof setTimeout> | undefined;
      let delay = 1000;
      const versions = new InvalidationWindow();
      const batch = new InvalidationBatch();
      const refresh = () => {
        if (active) {
          void client.invalidateQueries({ queryKey: [scopeKey, id] });
          if (global)
            void client.invalidateQueries({
              queryKey: [scopeKey, null, "remote", "machines"],
            });
        }
      };
      const schedule = () => {
        if (coalesce) return;
        coalesce = setTimeout(() => {
          coalesce = undefined;
          const matches = batch.take(scopeKey, id);
          if (active) {
            void client.invalidateQueries({
              predicate: (query) => matches(query.queryKey),
            });
            if (global)
              void client.invalidateQueries({
                queryKey: [scopeKey, null, "remote", "machines"],
              });
          }
        }, 100);
      };
      const connect = () => {
        if (!active) return;
        const url = new URL("/hub/v2/events/socket", window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("projectId", id);
        const transport = new WebSocket(url);
        socket = transport;
        transport.onopen = () => {
          if (!active || socket !== transport) return;
          opened.add(id);
          setConnected(opened.size === ids.length);
          delay = 1000;
          refresh();
        };
        transport.onmessage = (e) => {
          if (!active || socket !== transport) return;
          const frame = parseInvalidation(e.data, id);
          if (frame && versions.admit(frame)) {
            batch.add(frame);
            schedule();
          }
        };
        transport.onclose = (e) => {
          if (!active || socket !== transport) return;
          opened.delete(id);
          setConnected(false);
          if (e.code === 1008 || e.code === 4401 || e.code === 4403) {
            invalidateAuthentication();
            return;
          }
          reconnect = setTimeout(connect, delay + (Math.random() * delay) / 4);
          delay = Math.min(60000, delay * 2);
        };
        transport.onerror = () => transport.close();
      };
      connect();
      return () => {
        if (reconnect) clearTimeout(reconnect);
        if (coalesce) clearTimeout(coalesce);
        socket?.close();
      };
    });
    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [scopeKey, projectKey, client, global]);
  return connected;
}
export function requireController(
  binding: import("./remote").Control["ControllerBinding"] | null,
) {
  if (!binding)
    throw new ApiError(
      409,
      "controller-conflict",
      "Explicit control claim required",
    );
  return binding;
}
/** Follow the immutable operation identity on invalidation; no polling or resubmission. */
export function useAppliedReceipt<T extends { operationId: string }>(
  record: import("./remote").Control["SessionRecord"],
  initial: T | undefined,
) {
  return useRemoteQuery<T>(
    ["operation", record.sessionId, initial?.operationId],
    sessionPath(record.projectId, record.sessionId) +
      "/operations/" +
      encodeURIComponent(initial?.operationId ?? ""),
    !!initial?.operationId,
  );
}

import { useCallback, useState } from "react";
import { Dialog } from "../components/ui";

/** What opened the dialog: the command (`connect` or `search-provider`) and its arguments. */
export interface ProvidersRequest {
  name: string;
  args: string;
}

/**
 * Hook point for the Providers dialog. `/connect` and `/search-provider` call `openProviders`;
 * the window renders `<ProvidersDialog request={request} onClose={close} />` while `request` is set.
 */
export function useProvidersDialog() {
  const [request, setRequest] = useState<ProvidersRequest | null>(null);
  const openProviders = useCallback((name: string, args: string) => setRequest({ name, args }), []);
  const close = useCallback(() => setRequest(null), []);
  return { request, openProviders, close };
}

/** Placeholder: the provider list and connect flow replace this body. */
export function ProvidersDialog({ request, onClose }: { request: ProvidersRequest; onClose: () => void }) {
  return (
    <Dialog
      title="Providers"
      icon="command"
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="field-hint" data-request={request.name}>
        Providers for /{request.name}
        {request.args ? ` ${request.args}` : ""} appear here.
      </p>
    </Dialog>
  );
}

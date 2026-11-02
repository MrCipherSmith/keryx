import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HubContext, type HubContextValue } from "../src/app/hub-context";

/** A fresh query cache by default; callers may seed a cache for integration assertions. */
export function renderHub(
  children: ReactNode,
  context: HubContextValue,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>
      <HubContext.Provider value={context}>{children}</HubContext.Provider>
    </QueryClientProvider>,
  );
}

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { friendlyErrorMessage } from "./errors";
import { useToastStore } from "../state/toastStore";

function reportError(error: unknown): void {
  useToastStore.getState().pushError(friendlyErrorMessage(error));
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportError }),
  mutationCache: new MutationCache({ onError: reportError }),
  defaultOptions: {
    queries: { staleTime: 5_000, gcTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

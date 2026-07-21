import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api/queryClient";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { friendlyErrorMessage } from "./api/errors";
import { useToastStore } from "./state/toastStore";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root element not found");

window.addEventListener("unhandledrejection", (event) => {
  useToastStore.getState().pushError(friendlyErrorMessage(event.reason));
});

createRoot(el).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);

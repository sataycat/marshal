import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api/queryClient";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root element not found");
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
  </StrictMode>,
);

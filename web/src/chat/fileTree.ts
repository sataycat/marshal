import type { ChatFileEntry } from "../types";

export function filterChatFiles(entries: ChatFileEntry[], query: string): ChatFileEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(needle));
}

export function fileLanguage(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name.endsWith(".tsx")) return "tsx";
  if (name.endsWith(".ts")) return "ts";
  if (name.endsWith(".jsx")) return "jsx";
  if (name.endsWith(".js")) return "js";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".md")) return "md";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".py")) return "py";
  return "text";
}

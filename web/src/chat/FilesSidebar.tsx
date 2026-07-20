import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Folder, Search, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ChatFileEntry } from "../types";
import { filterChatFiles } from "./fileTree";

export function FilesSidebar({ files, loading, selectedPath, onOpen, onMention }: { files: ChatFileEntry[]; loading: boolean; selectedPath: string | null; onOpen: (path: string) => void; onMention: (path: string) => void }): JSX.Element {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const visible = useMemo(() => filterChatFiles(files, query), [files, query]);
  const roots = visible.filter((entry) => !entry.path.includes("/"));
  const isVisible = (entry: ChatFileEntry): boolean => {
    const parts = entry.path.split("/");
    return parts.slice(0, -1).every((_, index) => expanded.has(parts.slice(0, index + 1).join("/")));
  };
  return <aside className="flex min-h-0 w-full shrink-0 flex-col border-b border-border bg-panel md:w-56 md:border-r md:border-b-0 lg:w-64">
    <header className="border-b border-border px-3 py-3"><p className="text-sm font-semibold tracking-tight">Files</p><p className="text-xs text-muted-foreground">Read-only repository map</p><label className="sr-only" htmlFor="file-search">Search files</label><div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input id="file-search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 pl-7 text-xs" placeholder="Search files…" /></div></header>
     <ScrollArea className="min-h-0 flex-1"><div className="p-2">{loading && <p className="px-2 py-4 text-xs text-muted-foreground">Loading files...</p>}{!loading && roots.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">No matching files.</p>}{visible.filter(isVisible).map((entry) => { const depth = entry.path.split("/").length - 1; const directory = entry.type === "directory"; const open = expanded.has(entry.path); return <div key={entry.path} className="group flex items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}><button type="button" className={cn("flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-xs hover:bg-secondary", selectedPath === entry.path && "bg-secondary")} onClick={() => directory ? setExpanded((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }) : onOpen(entry.path)}>{directory ? (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : <FileCode2 className="size-3 shrink-0 text-muted-foreground" />}{directory && <Folder className="size-3 shrink-0 text-warn" aria-hidden />}<span className="truncate">{entry.path.split("/").pop()}</span>{entry.changed && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warn" title="Changed in git" />}{entry.touched && !entry.changed && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" title="Recently touched by the agent" />}</button>{!directory && <button type="button" className="hidden rounded p-1 text-muted-foreground hover:bg-secondary hover:text-primary group-hover:block" onClick={() => onMention(entry.path)} aria-label={`Mention ${entry.path}`} title="Add file mention"><Sparkles className="size-3" /></button>}</div>; })}</div></ScrollArea>
  </aside>;
}

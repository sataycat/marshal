import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Archive, AlertCircle, ArrowLeft, Bot, Check, LoaderCircle, MessageSquare, Pin, Plus, RefreshCw, Search, Send, Square, X } from "lucide-react";
import { cancelChatTurn, createChatThread, deleteChatThread, fetchChatAgents, fetchChatThread, sendChatMessage, updateChatThread } from "../api/client";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { useBoardContext } from "../board/BoardContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ChatMessage, ChatThread } from "../types";
import { timeInState } from "../time";

export function ChatSurface({ selectedId }: { selectedId?: string }): JSX.Element {
  const { threads, messagesForThread, status, dispatch, pushError } = useBoardContext();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ChatThread | null>(null);
  const [seeded, setSeeded] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(selectedId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedThreads, setArchivedThreads] = useState<ChatThread[]>([]);
  const [agentFilter, setAgentFilter] = useState("all");
  const [agents, setAgents] = useState<string[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setSeeded([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSelected(null);
    setSeeded([]);
    fetchChatThread(selectedId)
      .then((result) => {
        if (cancelled) return;
        setSelected(result.thread);
        setSeeded(result.messages);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unable to load this thread.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, loadAttempt]);

  useEffect(() => {
    if (selectedId) {
      const live = threads.find((thread) => thread.id === selectedId);
      if (live) setSelected(live);
    }
  }, [selectedId, threads]);

  useEffect(() => {
    fetchChatAgents().then(setAgents).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!showArchived) return;
    fetch("/api/threads?archived=true")
      .then((response) => response.json() as Promise<{ threads: ChatThread[] }>)
      .then((result) => setArchivedThreads(result.threads))
      .catch(() => undefined);
  }, [showArchived]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openNewThread = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const thread = await createChatThread({ agent_id: agents[0] ?? "builder" });
      dispatch({ type: "thread.created", payload: { thread }, timestamp: new Date().toISOString() });
      void navigate(`/chat/${thread.id}`);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to create a chat thread.");
    } finally {
      setCreating(false);
    }
  };

  const allThreads = showArchived ? [...threads, ...archivedThreads.filter((archived) => !threads.some((thread) => thread.id === archived.id))] : threads;
  const visibleThreads = allThreads.filter((thread) => (agentFilter === "all" || thread.agent_id === agentFilter) && (showArchived || !thread.archived));
  const mutateThread = async (thread: ChatThread, input: Parameters<typeof updateChatThread>[1]): Promise<void> => {
    try {
      const updated = await updateChatThread(thread.id, input);
      dispatch({ type: "thread.updated", payload: { thread: updated }, timestamp: new Date().toISOString() });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to update the thread.");
    }
  };
  const discardThread = async (thread: ChatThread): Promise<void> => {
    if (!window.confirm(`Discard ${thread.title}? This cannot be undone.`)) return;
    try {
      await deleteChatThread(thread.id);
      dispatch({ type: "thread.deleted", payload: { id: thread.id }, timestamp: new Date().toISOString() });
      if (selectedId === thread.id) void navigate("/chat");
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to discard the thread.");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className={cn("w-full shrink-0 border-b border-border bg-panel md:w-72 md:border-r md:border-b-0", selectedId && "hidden md:block")}>
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Threads</p>
            <p className="text-xs text-muted">{status === "open" ? "Connected" : "Reconnecting"}</p>
          </div>
          <Button type="button" size="sm" onClick={() => void openNewThread()} disabled={creating}>
            <Plus aria-hidden />
            New
          </Button>
          </div>
          <div className="mt-3 flex gap-2">
            <label className="sr-only" htmlFor="agent-filter">Filter agents</label>
            <select id="agent-filter" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 text-xs">
              <option value="all">All agents</option>
              {agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
            </select>
            <Button type="button" size="icon-sm" variant="outline" onClick={() => setSwitcherOpen(true)} aria-label="Switch thread" title="Switch thread (Cmd/Ctrl+K)"><Search aria-hidden /></Button>
          </div>
        </div>
        <ScrollArea className="max-h-[calc(100svh-11rem)] md:h-[calc(100svh-7rem)] md:max-h-none">
          <div className="p-2">
            {visibleThreads.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">{showArchived ? "No matching conversations." : "No conversations yet."}</p>}
            {visibleThreads.map((thread) => (
              <div key={thread.id} className={cn("group mb-1 rounded-md transition-colors hover:bg-secondary", thread.id === selectedId && "bg-secondary")}>
                <Link href={`/chat/${thread.id}`} className="flex items-start gap-3 px-3 py-2.5">
                <MessageSquare aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1 truncate text-sm font-medium">{thread.pinned && <Pin aria-hidden className="size-3 text-primary" />}{thread.title}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted"><StatusDot status={thread.status} />{thread.agent_id} · {timeInState(thread.last_message_at ?? thread.updated_at)}</span>
                </span>
                </Link>
                <div className="hidden items-center justify-end gap-0.5 px-2 pb-1 group-hover:flex">
                  <Button type="button" size="icon-xs" variant="ghost" onClick={() => void mutateThread(thread, { pinned: !thread.pinned })} aria-label={thread.pinned ? "Unpin thread" : "Pin thread"}><Pin aria-hidden /></Button>
                  <Button type="button" size="icon-xs" variant="ghost" onClick={() => void mutateThread(thread, { archived: !thread.archived })} aria-label={thread.archived ? "Unarchive thread" : "Archive thread"}><Archive aria-hidden /></Button>
                  {thread.status !== "closed" && <Button type="button" size="icon-xs" variant="ghost" onClick={() => void mutateThread(thread, { status: "closed" })} aria-label="Close thread"><Check aria-hidden /></Button>}
                  {thread.status === "draft" && <Button type="button" size="icon-xs" variant="ghost" onClick={() => void discardThread(thread)} aria-label="Discard thread"><X aria-hidden /></Button>}
                </div>
              </div>
            ))}
            <button type="button" className="mt-2 w-full px-3 text-left text-xs text-muted hover:text-text" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Hide archived" : "Show archived"}</button>
          </div>
        </ScrollArea>
      </aside>
      <section className={cn("min-h-0 flex-1", !selectedId && "hidden md:flex")}>
         {selectedId ? <ChatPane thread={selected} seeded={seeded} live={messagesForThread(selectedId)} loading={loading} loadError={loadError} onRetryLoad={() => setLoadAttempt((attempt) => attempt + 1)} onBack={() => void navigate("/chat")} /> : <EmptyChat onNew={() => void openNewThread()} />}
      </section>
      <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Switch thread</DialogTitle><DialogDescription>Search titles, agents, and recent activity.</DialogDescription></DialogHeader>
          <Input autoFocus value={switcherQuery} onChange={(event) => setSwitcherQuery(event.target.value)} placeholder="Search threads..." />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {threads.filter((thread) => !thread.archived && `${thread.title} ${thread.agent_id}`.toLowerCase().includes(switcherQuery.toLowerCase())).map((thread) => <button key={thread.id} type="button" className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-secondary" onClick={() => { setSwitcherOpen(false); setSwitcherQuery(""); void navigate(`/chat/${thread.id}`); }}><StatusDot status={thread.status} /><span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span><span className="text-xs text-muted">{thread.agent_id}</span></button>)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusDot({ status }: { status: ChatThread["status"] }): JSX.Element {
  return <span className={cn("inline-block size-1.5 rounded-full", status === "error" ? "bg-error" : status === "active" ? "bg-success" : "bg-muted")} aria-hidden />;
}

function EmptyChat({ onNew }: { onNew: () => void }): JSX.Element {
  return <div className="flex min-h-96 flex-1 items-center justify-center p-6"><div className="max-w-sm text-center"><Bot className="mx-auto mb-4 size-8 text-primary" aria-hidden /><h1 className="text-xl font-semibold">Start a conversation</h1><p className="mt-2 text-sm text-muted">Create a thread to talk with the configured coding agent.</p><Button className="mt-5" type="button" onClick={onNew}><Plus aria-hidden />New thread</Button></div></div>;
}

function ChatPane({ thread, seeded, live, loading, loadError, onRetryLoad, onBack }: { thread: ChatThread | null; seeded: ChatMessage[]; live: ChatMessage[]; loading: boolean; loadError: string | null; onRetryLoad: () => void; onBack: () => void }): JSX.Element {
  const { pushError, dispatch } = useBoardContext();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const messages = useMemo(() => {
    const byId = new Map<number, ChatMessage>();
    for (const message of seeded) byId.set(message.id, message);
    for (const message of live) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [seeded, live]);
  const lastPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  useEffect(() => {
    const content = listRef.current;
    const viewport = content?.parentElement;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, sending]);

  const send = async (text = draft): Promise<void> => {
    const content = text.trim();
    if (!thread || !content || sending) return;
    setSending(true);
    setSendError(null);
    setDraft("");
    try {
      const result = await sendChatMessage(thread.id, content);
      dispatch({ type: "thread.message", payload: { threadId: thread.id, message: result.userMessage }, timestamp: new Date().toISOString() });
      dispatch({ type: "thread.message", payload: { threadId: thread.id, message: result.assistantMessage }, timestamp: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The agent could not complete the turn.";
      setSendError(message);
      setDraft(content);
    } finally {
      setSending(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!thread) return;
    try {
      await cancelChatTurn(thread.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to cancel the turn.";
      setSendError(message);
      pushError(message);
    }
  };

  if (loading) return <div className="flex flex-1 items-center justify-center text-sm text-muted"><LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden />Loading conversation...</div>;
  if (loadError || !thread) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><AlertCircle className="size-7 text-error" aria-hidden /><p className="text-sm text-error">{loadError ?? "Thread not found."}</p><Button type="button" variant="outline" onClick={onRetryLoad}><RefreshCw aria-hidden />Retry</Button></div>;

  return <div className="flex min-h-0 flex-1 flex-col">
     <header className="flex items-center gap-2 border-b border-border bg-panel px-3 py-3 md:px-6"><Button type="button" size="icon" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to threads" title="Back to threads"><ArrowLeft aria-hidden /></Button><div className="min-w-0"><h1 className="truncate text-sm font-semibold">{thread.title}</h1><p className="truncate text-xs text-muted">{thread.cwd}</p></div><span className="ml-auto flex items-center gap-1.5 text-xs text-muted"><StatusDot status={thread.status} />{thread.status}</span></header>
    <ScrollArea className="min-h-0 flex-1"><div ref={listRef} className="mx-auto max-w-3xl space-y-5 p-4 md:p-8">
      {messages.length === 0 && <p className="py-12 text-center text-sm text-muted">Send a message to begin.</p>}
      {messages.map((message) => <article key={message.id} className={cn("max-w-[92%]", message.role === "user" ? "ml-auto" : "mr-auto")}><p className="mb-1 text-[0.68rem] font-bold tracking-wider text-muted uppercase">{message.role}</p><div className={cn("rounded-lg border px-4 py-3", message.role === "user" ? "border-primary/20 bg-primary/5" : "border-border bg-panel")}><MarkdownWithCode className="text-sm leading-6" src={message.content} /></div></article>)}
      {sending && <p className="flex items-center gap-2 text-xs text-muted"><LoaderCircle className="size-3.5 animate-spin" aria-hidden />Streaming response...</p>}
    </div></ScrollArea>
    <div className="border-t border-border bg-panel p-3 md:p-4"><div className="mx-auto max-w-3xl">
      {(sendError || thread.status === "error") && <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error"><span>{sendError ?? "The last turn failed."}</span><Button type="button" size="xs" variant="outline" onClick={() => void send(lastPrompt)} disabled={sending || !lastPrompt}><RefreshCw aria-hidden />Retry</Button></div>}
      <div className="flex items-end gap-2"><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Message the coding agent..." disabled={sending} rows={3} /><Button type="button" onClick={() => void (sending ? cancel() : send())} disabled={!sending && draft.trim().length === 0} variant={sending ? "destructive" : "default"}>{sending ? <><Square aria-hidden />Stop</> : <><Send aria-hidden />Send</>}</Button></div>
      <p className="mt-1 text-right text-[0.68rem] text-muted">Enter to send, Shift+Enter for a new line</p>
    </div></div>
  </div>;
}

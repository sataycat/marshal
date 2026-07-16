import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { AlertCircle, ArrowLeft, Bot, LoaderCircle, MessageSquare, Plus, RefreshCw, Send, Square } from "lucide-react";
import { cancelChatTurn, createChatThread, fetchChatThread, sendChatMessage } from "../api/client";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { useBoardContext } from "../board/BoardContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChatMessage, ChatThread } from "../types";

export function ChatSurface({ selectedId }: { selectedId?: string }): JSX.Element {
  const { threads, messagesForThread, status, dispatch, pushError } = useBoardContext();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ChatThread | null>(null);
  const [seeded, setSeeded] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(selectedId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

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

  const openNewThread = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const thread = await createChatThread({ agent_id: "builder" });
      dispatch({ type: "thread.created", payload: { thread }, timestamp: new Date().toISOString() });
      void navigate(`/chat/${thread.id}`);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to create a chat thread.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className={cn("w-full shrink-0 border-b border-border bg-panel md:w-72 md:border-r md:border-b-0", selectedId && "hidden md:block")}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Threads</p>
            <p className="text-xs text-muted">{status === "open" ? "Connected" : "Reconnecting"}</p>
          </div>
          <Button type="button" size="sm" onClick={() => void openNewThread()} disabled={creating}>
            <Plus aria-hidden />
            New
          </Button>
        </div>
        <ScrollArea className="max-h-[calc(100svh-11rem)] md:h-[calc(100svh-7rem)] md:max-h-none">
          <div className="p-2">
            {threads.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No conversations yet.</p>}
            {threads.map((thread) => (
              <Link key={thread.id} href={`/chat/${thread.id}`} className={cn("mb-1 flex items-start gap-3 rounded-md px-3 py-3 transition-colors hover:bg-secondary", thread.id === selectedId && "bg-secondary")}>
                <MessageSquare aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{thread.title}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted"><StatusDot status={thread.status} />{thread.agent_id}</span>
                </span>
              </Link>
            ))}
          </div>
        </ScrollArea>
      </aside>
      <section className={cn("min-h-0 flex-1", !selectedId && "hidden md:flex")}>
         {selectedId ? <ChatPane thread={selected} seeded={seeded} live={messagesForThread(selectedId)} loading={loading} loadError={loadError} onRetryLoad={() => setLoadAttempt((attempt) => attempt + 1)} onBack={() => void navigate("/chat")} /> : <EmptyChat onNew={() => void openNewThread()} />}
      </section>
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

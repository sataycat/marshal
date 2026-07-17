import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Archive, AlertCircle, ArrowLeft, Bot, Check, ImagePlus, LoaderCircle, MessageSquare, Pencil, Pin, Plus, RefreshCw, Search, Send, Square, X } from "lucide-react";
import { chatAttachmentUrl } from "../api/client";
import { useChatAgentsQuery, useChatAttachmentsQuery, useChatFileQuery, useChatFilesQuery, useChatPermissionsQuery, useChatThreadQuery, useChatThreadsQuery, useCreateThreadMutation, useDeleteThreadMutation, usePermissionMutation, useSendChatMutation, useUpdateThreadMutation, useCancelChatMutation, useUploadAttachmentMutation } from "../api/queries";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { EditorPane } from "./EditorPane";
import { useChatStore, selectMessages, selectPermissions, selectThreads } from "../state/chatStore";
import { useTaskStore } from "../state/taskStore";
import { useToastStore } from "../state/toastStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ChatAttachment, ChatMessage, ChatThread, PendingPermission } from "../types";
import { FilesSidebar } from "./FilesSidebar";
import { timeInState } from "../time";

export function ChatSurface({ selectedId }: { selectedId?: string }): JSX.Element {
  const threads = useChatStore(selectThreads);
  const liveMessages = useChatStore(selectMessages(selectedId ?? ""));
  const status = useTaskStore((state) => state.socketStatus);
  const applyChatEvent = useChatStore((state) => state.applyChatEvent);
  const pushError = useToastStore((state) => state.pushError);
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ChatThread | null>(null);
  const threadQuery = useChatThreadQuery(selectedId);
  const agentsQuery = useChatAgentsQuery();
  const archivedQuery = useChatThreadsQuery(true);
  const [showArchived, setShowArchived] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const agents = agentsQuery.data ?? [];
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const createThreadMutation = useCreateThreadMutation();
  const updateThreadMutation = useUpdateThreadMutation();
  const deleteThreadMutation = useDeleteThreadMutation();

  useEffect(() => {
    if (selectedId) setSelected(threads.find((thread) => thread.id === selectedId) ?? threadQuery.data?.thread ?? null);
    else setSelected(null);
  }, [selectedId, threads, threadQuery.data?.thread]);

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
      const thread = await createThreadMutation.mutateAsync({ agent_id: agents[0] ?? "builder" });
       applyChatEvent({ type: "thread.created", payload: { thread }, timestamp: new Date().toISOString() });
      void navigate(`/chat/${thread.id}`);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to create a chat thread.");
    } finally {
      setCreating(false);
    }
  };

  const allThreads = showArchived ? [...threads, ...(archivedQuery.data ?? []).filter((archived) => !threads.some((thread) => thread.id === archived.id))] : threads;
  const visibleThreads = allThreads.filter((thread) => (agentFilter === "all" || thread.agent_id === agentFilter) && (showArchived || !thread.archived));
  const mutateThread = async (thread: ChatThread, input: Parameters<typeof updateThreadMutation.mutateAsync>[0]["input"]): Promise<void> => {
    try {
      const updated = await updateThreadMutation.mutateAsync({ id: thread.id, input });
       applyChatEvent({ type: "thread.updated", payload: { thread: updated }, timestamp: new Date().toISOString() });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to update the thread.");
    }
  };
  const discardThread = async (thread: ChatThread): Promise<void> => {
    if (!window.confirm(`Discard ${thread.title}? This cannot be undone.`)) return;
    try {
      await deleteThreadMutation.mutateAsync(thread.id);
       applyChatEvent({ type: "thread.deleted", payload: { id: thread.id }, timestamp: new Date().toISOString() });
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
             <p className="text-xs text-muted">{status === "open" ? "Connected" : status === "connecting" ? "Connecting..." : "Reconnecting..."}</p>
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
             {visibleThreads.length === 0 && <div className="px-3 py-8 text-center text-sm text-muted"><p>{showArchived ? "No matching conversations." : "No conversations yet."}</p>{!showArchived && <p className="mt-1 text-xs">Create a thread to start working with an agent.</p>}</div>}
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
          {selectedId ? <ThreadWorkspace thread={selected} seeded={threadQuery.data?.messages ?? []} live={liveMessages} loading={threadQuery.isPending} loadError={threadQuery.error?.message ?? null} onRetryLoad={() => void threadQuery.refetch()} onBack={() => void navigate("/chat")} /> : <EmptyChat onNew={() => void openNewThread()} />}
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

function ThreadWorkspace({ thread, seeded, live, loading, loadError, onRetryLoad, onBack }: { thread: ChatThread | null; seeded: ChatMessage[]; live: ChatMessage[]; loading: boolean; loadError: string | null; onRetryLoad: () => void; onBack: () => void }): JSX.Element {
  const pushError = useToastStore((state) => state.pushError);
  const busPermissions = useChatStore(selectPermissions(thread?.id ?? ""));
  const [scratch, setScratch] = useState(thread?.scratch_markdown ?? "");
  const [sending, setSending] = useState(false);
  const filesQuery = useChatFilesQuery(thread?.id);
  const permissionsQuery = useChatPermissionsQuery(thread?.id);
  const attachmentsQuery = useChatAttachmentsQuery(thread?.id);
  const permissionMutation = usePermissionMutation();
  const sendMutation = useSendChatMutation();
  const updateMutation = useUpdateThreadMutation();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);
  const fileQuery = useChatFileQuery(thread?.id, selectedFile?.path);
  const files = filesQuery.data ?? [];
  const permissions = permissionsQuery.data ?? [];
  const attachments = attachmentsQuery.data ?? [];
  const [mobilePane, setMobilePane] = useState<"files" | "editor" | "chat">("chat");

  useEffect(() => {
    setScratch(thread?.scratch_markdown ?? "");
  }, [thread?.id, thread?.scratch_markdown]);

  useEffect(() => {
    if (!thread || scratch === thread.scratch_markdown) return;
    const timer = window.setTimeout(() => {
      updateMutation.mutate({ id: thread.id, input: { scratch_markdown: scratch } });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [scratch, thread, updateMutation]);

  const visiblePermissions = busPermissions.length > 0 ? busPermissions : permissions;

  const decide = async (requestId: string, action: "approve" | "deny"): Promise<void> => {
    if (!thread) return;
    try {
      await permissionMutation.mutateAsync({ id: thread.id, requestId, action });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Permission request is no longer active.");
    }
  };

  const openFile = async (path: string): Promise<void> => {
    if (!thread) return;
    try {
      setSelectedFile({ path, content: "" });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to open file.");
    }
  };

  const mentionFile = (path: string): void => {
    setScratch((current) => `${current}${current.length > 0 && !current.endsWith(" ") ? " " : ""}@${path} `);
  };

  const send = async (attachmentIds: string[] = attachments.map((attachment) => attachment.id)): Promise<void> => {
    const content = scratch.trim();
    if (!thread || (!content && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      await sendMutation.mutateAsync({ id: thread.id, content, attachmentIds });
      setScratch("");
    } catch (error) {
      pushError(error instanceof Error ? error.message : "The agent could not complete the turn.");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (fileQuery.data) setSelectedFile(fileQuery.data);
  }, [fileQuery.data]);
  if (loading || loadError || !thread) return <ChatPane thread={thread} seeded={seeded} live={live} permissions={visiblePermissions} attachments={attachments} onAttachments={(items) => queryClient.setQueryData(["thread", thread?.id, "attachments"], items)} onPermission={decide} loading={loading} loadError={loadError} onRetryLoad={onRetryLoad} onBack={onBack} draft={scratch} onDraftChange={setScratch} onSendDraft={send} sending={sending} />;
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex border-b border-border bg-panel p-1 md:hidden"><Button type="button" size="xs" variant={mobilePane === "files" ? "default" : "ghost"} className="flex-1" onClick={() => setMobilePane("files")}>Files</Button><Button type="button" size="xs" variant={mobilePane === "editor" ? "default" : "ghost"} className="flex-1" onClick={() => setMobilePane("editor")}>Draft</Button><Button type="button" size="xs" variant={mobilePane === "chat" ? "default" : "ghost"} className="flex-1" onClick={() => setMobilePane("chat")}>Chat</Button></div><div className="flex min-h-0 flex-1 flex-col md:flex-row"><div className={cn("min-h-0 flex-1", mobilePane !== "files" && "hidden md:flex")}><FilesSidebar files={files} loading={filesQuery.isPending} selectedPath={selectedFile?.path ?? null} onOpen={(path) => void openFile(path)} onMention={mentionFile} /></div><div className={cn("min-h-0 flex-1", mobilePane !== "editor" && "hidden md:flex")}><EditorPane value={scratch} onChange={setScratch} onSend={() => void send()} sending={sending} filePath={selectedFile?.path} fileContent={selectedFile?.content} onCloseFile={() => setSelectedFile(null)} /></div><div className={cn("min-h-0 flex-1", mobilePane !== "chat" && "hidden md:flex")}><ChatPane thread={thread} seeded={seeded} live={live} permissions={visiblePermissions} attachments={attachments} onAttachments={(items) => queryClient.setQueryData(["thread", thread.id, "attachments"], items)} onPermission={decide} loading={loading} loadError={loadError} onRetryLoad={onRetryLoad} onBack={onBack} draft={scratch} onDraftChange={setScratch} onSendDraft={send} sending={sending} /></div></div></div>;
}

function StatusDot({ status }: { status: ChatThread["status"] }): JSX.Element {
  return <span className={cn("inline-block size-1.5 rounded-full", status === "error" ? "bg-error" : status === "active" ? "bg-success" : "bg-muted")} aria-hidden />;
}

function EmptyChat({ onNew }: { onNew: () => void }): JSX.Element {
  return <div className="flex min-h-96 flex-1 items-center justify-center p-6"><div className="max-w-sm text-center"><Bot className="mx-auto mb-4 size-8 text-primary" aria-hidden /><h1 className="text-xl font-semibold">Start a conversation</h1><p className="mt-2 text-sm text-muted">Create a thread to talk with the configured coding agent.</p><Button className="mt-5" type="button" onClick={onNew}><Plus aria-hidden />New thread</Button></div></div>;
}

function ChatPane({ thread, seeded, live, permissions, attachments, onAttachments, onPermission, loading, loadError, onRetryLoad, onBack, draft, onDraftChange, onSendDraft, sending: externalSending }: { thread: ChatThread | null; seeded: ChatMessage[]; live: ChatMessage[]; permissions: PendingPermission[]; attachments: ChatAttachment[]; onAttachments: (items: ChatAttachment[]) => void; onPermission: (requestId: string, action: "approve" | "deny") => Promise<void>; loading: boolean; loadError: string | null; onRetryLoad: () => void; onBack: () => void; draft: string; onDraftChange: (value: string) => void; onSendDraft: (attachmentIds?: string[]) => Promise<void>; sending: boolean }): JSX.Element {
  const pushError = useToastStore((state) => state.pushError);
  const applyChatEvent = useChatStore((state) => state.applyChatEvent);
  const [draftSending, setDraftSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const sendMutation = useSendChatMutation();
  const uploadMutation = useUploadAttachmentMutation();
  const cancelMutation = useCancelChatMutation();
  const inputRef = useRef<HTMLInputElement | null>(null);
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
  }, [messages, draftSending, externalSending]);

  const send = async (text = draft): Promise<void> => {
    const content = text.trim();
    if (!thread || !content || draftSending || externalSending) return;
    setDraftSending(true);
    setSendError(null);
    onDraftChange("");
    try {
       const result = await sendMutation.mutateAsync({ id: thread.id, content, attachmentIds: attachments.map((attachment) => attachment.id) });
       applyChatEvent({ type: "thread.message", payload: { threadId: thread.id, message: result.userMessage }, timestamp: new Date().toISOString() });
       applyChatEvent({ type: "thread.message", payload: { threadId: thread.id, message: result.assistantMessage }, timestamp: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The agent could not complete the turn.";
      setSendError(message);
      onDraftChange(content);
    } finally {
      setDraftSending(false);
    }
  };

  const upload = async (files: FileList | File[]): Promise<void> => {
    if (!thread || uploading) return;
    setUploading(true);
    try {
      const uploaded = [...attachments];
       for (const file of [...files]) uploaded.push(await uploadMutation.mutateAsync({ id: thread.id, file }));
      onAttachments(uploaded);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Image upload failed. Check the type and 10 MiB limit.");
    } finally { setUploading(false); }
  };

  const cancel = async (): Promise<void> => {
    if (!thread) return;
    try {
       await cancelMutation.mutateAsync(thread.id);
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
       {messages.map((message) => <article key={message.id} className={cn("max-w-[92%]", message.role === "user" ? "ml-auto" : "mr-auto")}><div className="mb-1 flex items-center gap-2"><p className="text-[0.68rem] font-bold tracking-wider text-muted uppercase">{message.role}</p>{message.role === "user" && <button type="button" className="text-[0.68rem] text-muted hover:text-text" onClick={() => onDraftChange(message.content)}><Pencil aria-hidden className="mr-1 inline size-3" />Edit</button>}</div><div className={cn("rounded-lg border px-4 py-3", message.role === "user" ? "border-primary/20 bg-primary/5" : "border-border bg-panel")}>
         {message.attachment_ids.map((id) => <img key={id} src={chatAttachmentUrl(message.thread_id, id)} alt="Attached image" className="mb-2 max-h-64 rounded border object-contain" />)}<MarkdownWithCode className="text-sm leading-6" src={message.content} /></div></article>)}
       {permissions.map((request) => <PermissionCard key={request.requestId} request={request} onDecision={onPermission} />)}
       {(draftSending || externalSending) && <p className="flex items-center gap-2 text-xs text-muted"><LoaderCircle className="size-3.5 animate-spin" aria-hidden />Streaming response...</p>}
    </div></ScrollArea>
    <div className="border-t border-border bg-panel p-3 md:p-4"><div className="mx-auto max-w-3xl">
       {(sendError || thread.status === "error") && <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error"><span>{sendError ?? "The last turn failed."}</span><Button type="button" size="xs" variant="outline" onClick={() => void send(lastPrompt)} disabled={draftSending || externalSending || !lastPrompt}><RefreshCw aria-hidden />Retry</Button></div>}
        {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map((attachment) => <div key={attachment.id} className="relative"><img src={chatAttachmentUrl(attachment.thread_id, attachment.id)} alt={attachment.filename} className="size-14 rounded border object-cover" /><button type="button" className="absolute -right-1 -top-1 rounded-full bg-panel text-error" onClick={() => onAttachments(attachments.filter((item) => item.id !== attachment.id))} aria-label={`Remove ${attachment.filename}`}><X className="size-3" /></button></div>)}</div>}
        <div className="flex items-end gap-2"><input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" onChange={(event) => { if (event.target.files) void upload(event.target.files); event.target.value = ""; }} /><Button type="button" size="icon" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading || draftSending || externalSending} aria-label="Attach image" title="Attach image"><ImagePlus aria-hidden /></Button><Textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void onSendDraft(); } }} placeholder={uploading ? "Uploading image..." : "Message the coding agent..."} disabled={draftSending || externalSending} rows={3} /><Button type="button" onClick={() => void ((draftSending || externalSending) ? cancel() : send())} disabled={!(draftSending || externalSending) && draft.trim().length === 0 && attachments.length === 0} variant={(draftSending || externalSending) ? "destructive" : "default"}>{(draftSending || externalSending) ? <><Square aria-hidden />Stop</> : <><Send aria-hidden />Send</>}</Button></div>
      <p className="mt-1 text-right text-[0.68rem] text-muted">Enter to send, Shift+Enter for a new line</p>
    </div></div>
  </div>;
}

function PermissionCard({ request, onDecision }: { request: PendingPermission; onDecision: (requestId: string, action: "approve" | "deny") => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const decide = async (action: "approve" | "deny"): Promise<void> => { setBusy(true); await onDecision(request.requestId, action); };
  return <article className="mr-auto max-w-[92%] rounded-lg border border-warn/40 bg-warn/5 px-4 py-3"><p className="text-xs font-semibold text-warn">Permission needed</p><p className="mt-1 text-sm">Agent wants to <strong>{request.tool}</strong>{request.kind ? ` (${request.kind})` : ""}.</p>{request.options.length > 0 && <p className="mt-1 text-xs text-muted">The agent supplied {request.options.map((option) => option.name).join(" / ")}.</p>}<div className="mt-3 flex gap-2"><Button type="button" size="xs" onClick={() => void decide("approve")} disabled={busy}>Approve once</Button><Button type="button" size="xs" variant="outline" onClick={() => void decide("deny")} disabled={busy}>Deny</Button></div></article>;
}

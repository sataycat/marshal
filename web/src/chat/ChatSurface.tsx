import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { Link, useLocation } from "wouter";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderGit2,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { chatAttachmentUrl } from "../api/client";
import {
  useCancelChatMutation,
  useChatAgentsQuery,
  useChatAttachmentsQuery,
  useChatFileQuery,
  useChatFilesQuery,
  useChatPermissionsQuery,
  useChatThreadQuery,
  useChatThreadsQuery,
  useCreateThreadMutation,
  useDeleteThreadMutation,
  useDirectorySuggestionsQuery,
  usePermissionMutation,
  useRegisterRepositoryMutation,
  useResubmitChatMutation,
  useRepositoriesQuery,
  useSelectRepositoryMutation,
  useSendChatMutation,
  useUpdateThreadMutation,
  useUploadAttachmentMutation,
} from "../api/queries";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { CodeBlock } from "../codemirror/CodeBlock";
import { useChatStore, selectMessages, selectPermissions, selectThreads } from "../state/chatStore";
import { useTaskStore } from "../state/taskStore";
import { useToastStore } from "../state/toastStore";
import { useNow } from "../hooks/useNow";
import { timeInState } from "../time";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmContext } from "../components/ConfirmDialog";
import { ThreadStatusDot, threadStatusLabel } from "../components/status";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ChatAttachment, ChatMessage, ChatThread, InstalledAgent, PendingPermission } from "../types";
import { FilesSidebar } from "./FilesSidebar";
import { groupThreadsByProject } from "./sidebar";

export function ChatSurface({ selectedId }: { selectedId?: string }): JSX.Element {
  const threads = useChatStore(useShallow(selectThreads));
  const liveMessages = useChatStore(useShallow(selectMessages(selectedId ?? "")));
  const status = useTaskStore((state) => state.socketStatus);
  const applyChatEvent = useChatStore((state) => state.applyChatEvent);
  const pushError = useToastStore((state) => state.pushError);
  const { confirm } = useConfirmContext();
  const [, navigate] = useLocation();
  const [selected, setSelected] = useState<ChatThread | null>(null);
  const threadQuery = useChatThreadQuery(selectedId);
  const agentsQuery = useChatAgentsQuery();
  const archivedQuery = useChatThreadsQuery(true);
  const [showArchived, setShowArchived] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const agents = (agentsQuery.data ?? []).filter((agent) => agent.status === "installed" && agent.readiness_status === "ready");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const deleteThreadMutation = useDeleteThreadMutation();
  const updateThreadMutation = useUpdateThreadMutation();
  const now = useNow(30000);

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

  const openNewThread = (): void => { void navigate("/chat"); };

  const allThreads = showArchived ? [...threads, ...(archivedQuery.data ?? []).filter((archived) => !threads.some((thread) => thread.id === archived.id))] : threads;
  const visibleThreads = allThreads.filter((thread) => (agentFilter === "all" || `${thread.agent_id}@${thread.agent_version}` === agentFilter) && (showArchived || !thread.archived));
  const projectGroups = groupThreadsByProject(visibleThreads);
  const mutateThread = async (thread: ChatThread, input: Parameters<typeof updateThreadMutation.mutateAsync>[0]["input"]): Promise<void> => {
    try {
      const updated = await updateThreadMutation.mutateAsync({ id: thread.id, input });
      applyChatEvent({ type: "thread.updated", payload: { thread: updated }, timestamp: new Date().toISOString() });
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to update the thread.");
    }
  };
  const discardThread = async (thread: ChatThread): Promise<void> => {
    const ok = await confirm({
      title: "Discard thread",
      message: `Discard "${thread.title}"? This cannot be undone.`,
      confirmLabel: "Discard",
    });
    if (!ok) return;
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
      <aside className={cn("flex w-full shrink-0 flex-col border-b border-border bg-panel md:w-76 md:border-r md:border-b-0", selectedId && "hidden md:flex")}>
        <div className="border-b border-border px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-tight">Threads</p>
              <p className="text-xs text-muted-foreground">{status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…"}</p>
            </div>
            <Button type="button" size="sm" onClick={openNewThread}>
              <Plus aria-hidden />
              New
            </Button>
          </div>
          <div className="mt-3 flex gap-2">
            <label className="sr-only" htmlFor="agent-filter">Filter threads by agent</label>
            <select
              id="agent-filter"
              value={agentFilter}
              onChange={(event) => setAgentFilter(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 text-xs text-text outline-none focus-visible:border-ring"
            >
              <option value="all">All agents</option>
              {agents.map((agent) => <option key={`${agent.id}@${agent.version}`} value={`${agent.id}@${agent.version}`}>{agent.id}@{agent.version}</option>)}
            </select>
            <Button type="button" size="icon-sm" variant="outline" onClick={() => setSwitcherOpen(true)} aria-label="Switch thread (Cmd/Ctrl+K)" title="Switch thread (Cmd/Ctrl+K)"><Search aria-hidden /></Button>
          </div>
        </div>
        <ScrollArea className="max-h-[calc(100svh-11.5rem)] md:h-[calc(100svh-7.5rem)] md:max-h-none">
          <div className="p-2">
            {visibleThreads.length === 0 && (
              <div className="px-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">{showArchived ? "No matching threads." : "No threads yet."}</p>
                {!showArchived && <p className="mt-1 text-xs text-muted-foreground">Start a thread to work with an agent in this repository.</p>}
              </div>
            )}
            {projectGroups.map((group) => (
              <section key={group.repoRoot} className="mb-4 last:mb-0">
                <div className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground" title={group.repoRoot}>
                  <Folder aria-hidden className="size-3" />
                  <span className="truncate normal-case tracking-normal">{group.name}</span>
                </div>
                <div className="space-y-0.5">
                  {group.threads.map((thread) => (
                    <div key={thread.id} className={cn("group relative rounded-lg transition-colors hover:bg-secondary focus-within:bg-secondary", thread.id === selectedId && "bg-secondary")}>
                      <Link href={`/chat/${thread.id}`} className="block min-w-0 rounded-lg px-2.5 py-2 pr-10">
                        <span className="flex min-w-0 items-center gap-2">
                          <ThreadStatusDot status={thread.status} />
                          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{thread.title}</span>
                          {thread.pinned && <Pin aria-label="Pinned" className="size-3 shrink-0 text-primary" />}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3.5 text-[0.6875rem] text-muted-foreground">
                          <span className="truncate font-mono">{thread.agent_id}</span>
                          <span aria-hidden>·</span>
                          <span className="shrink-0">{timeInState(thread.last_message_at ?? thread.updated_at, now)} ago</span>
                        </span>
                      </Link>
                      <ThreadActions thread={thread} onMutate={mutateThread} onDiscard={discardThread} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
            <button type="button" className="mt-2 w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-text" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Hide archived" : "Show archived"}</button>
          </div>
        </ScrollArea>
      </aside>
      <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !selectedId && "hidden md:flex")}>
        {selectedId
          ? <ThreadWorkspace thread={selected} seeded={threadQuery.data?.messages ?? []} live={liveMessages} loading={threadQuery.isPending} loadError={threadQuery.error?.message ?? null} onRetryLoad={() => void threadQuery.refetch()} onBack={() => void navigate("/chat")} />
          : <NewChatComposer agents={agents} onCreated={(thread) => { applyChatEvent({ type: "thread.created", payload: { thread }, timestamp: new Date().toISOString() }); void navigate(`/chat/${thread.id}`); }} />}
      </section>
      <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Switch thread</DialogTitle>
            <DialogDescription>Search titles, agents, and recent activity.</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={switcherQuery} onChange={(event) => setSwitcherQuery(event.target.value)} placeholder="Search threads…" />
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {threads
              .filter((thread) => !thread.archived && `${thread.title} ${thread.agent_id} ${thread.agent_version}`.toLowerCase().includes(switcherQuery.toLowerCase()))
              .map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-secondary"
                  onClick={() => { setSwitcherOpen(false); setSwitcherQuery(""); void navigate(`/chat/${thread.id}`); }}
                >
                  <ThreadStatusDot status={thread.status} />
                  <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
                  <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">{thread.agent_id}</span>
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ThreadWorkspace({ thread, seeded, live, loading, loadError, onRetryLoad, onBack }: { thread: ChatThread | null; seeded: ChatMessage[]; live: ChatMessage[]; loading: boolean; loadError: string | null; onRetryLoad: () => void; onBack: () => void }): JSX.Element {
  const pushError = useToastStore((state) => state.pushError);
  const busPermissions = useChatStore(useShallow(selectPermissions(thread?.id ?? "")));
  const [draft, setDraft] = useState("");
  const filesQuery = useChatFilesQuery(thread?.id);
  const permissionsQuery = useChatPermissionsQuery(thread?.id);
  const attachmentsQuery = useChatAttachmentsQuery(thread?.id);
  const agentsQuery = useChatAgentsQuery();
  const permissionMutation = usePermissionMutation();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);
  const fileQuery = useChatFileQuery(thread?.id, selectedFile?.path);
  const files = filesQuery.data ?? [];
  const permissions = permissionsQuery.data ?? [];
  const attachments = attachmentsQuery.data ?? [];
  const installedAgent = thread ? agentsQuery.data?.find((agent) => agent.id === thread.agent_id && agent.version === thread.agent_version && (!thread.agent_provenance?.installation_id || agent.installation_id === thread.agent_provenance.installation_id)) : undefined;
  const supportsImages = Boolean(installedAgent?.capabilities?.prompt.image);
  const [filesOpen, setFilesOpen] = useState(false);

  const visiblePermissions = (busPermissions.length > 0 ? busPermissions : permissions).filter((request) => request.status === "pending");

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

  const mentionFile = (path: string): void => setDraft((current) => `${current}${current.length > 0 && !current.endsWith(" ") ? " " : ""}@${path} `);

  useEffect(() => {
    if (fileQuery.data) setSelectedFile(fileQuery.data);
  }, [fileQuery.data]);

  return (
    <div className="flex min-h-0 flex-1">
      <ChatPane
        thread={thread}
        seeded={seeded}
        live={live}
        permissions={visiblePermissions}
        attachments={attachments}
        supportsImages={supportsImages}
        authMethods={installedAgent?.auth_methods ?? []}
        onAttachments={(items) => queryClient.setQueryData(["thread", thread?.id, "attachments"], items)}
        onPermission={decide}
        loading={loading}
        loadError={loadError}
        onRetryLoad={onRetryLoad}
        onBack={onBack}
        draft={draft}
        onDraftChange={setDraft}
        sending={false}
        filesOpen={filesOpen}
        onToggleFiles={() => setFilesOpen((open) => !open)}
      />
      <aside className={cn("hidden min-h-0 shrink-0 border-l border-border bg-panel transition-[width] md:flex md:flex-col", filesOpen ? "w-72" : "w-0 overflow-hidden border-l-0")}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <FilesSidebar files={files} loading={filesQuery.isPending} selectedPath={selectedFile?.path ?? null} onOpen={(path) => void openFile(path)} onMention={mentionFile} />
          </div>
          {selectedFile && (
            <div className="flex min-h-0 basis-1/2 flex-col border-t border-border">
              <div className="flex items-center gap-2 px-3 py-2">
                <FileText className="size-4 text-primary" aria-hidden />
                <span className="truncate text-xs font-medium">{selectedFile.path}</span>
                <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-text" onClick={() => setSelectedFile(null)}>Close</button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
                <CodeBlock value={fileQuery.isPending ? "Loading file…" : selectedFile.content} lang={selectedFile.path.split(".").pop()} />
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function ThreadActions({ thread, onMutate, onDiscard }: { thread: ChatThread; onMutate: (thread: ChatThread, input: { status?: ChatThread["status"]; archived?: boolean; pinned?: boolean }) => Promise<void>; onDiscard: (thread: ChatThread) => Promise<void> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={menuRef} className={cn("absolute inset-y-0 right-1 flex items-center rounded-lg pl-1 opacity-100 md:bg-secondary md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100", open && "md:opacity-100")}>
      <Button type="button" size="icon-xs" variant="ghost" className="bg-panel/80 md:bg-transparent" onClick={() => setOpen((value) => !value)} aria-label={`Actions for ${thread.title}`} aria-haspopup="menu" aria-expanded={open}><MoreHorizontal aria-hidden /></Button>
      {open && (
        <div role="menu" className="absolute right-0 top-8 z-20 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
          <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary" onClick={() => { setOpen(false); void onMutate(thread, { pinned: !thread.pinned }); }}><Pin aria-hidden className="size-3.5" />{thread.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary" onClick={() => { setOpen(false); void onMutate(thread, { archived: !thread.archived }); }}><Archive aria-hidden className="size-3.5" />{thread.archived ? "Unarchive" : "Archive"}</button>
          {thread.status !== "closed" && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary" onClick={() => { setOpen(false); void onMutate(thread, { status: "closed" }); }}><Check aria-hidden className="size-3.5" />Close</button>}
          {thread.status === "draft" && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-error hover:bg-error-bg" onClick={() => { setOpen(false); void onDiscard(thread); }}><Trash2 aria-hidden className="size-3.5" />Discard</button>}
        </div>
      )}
    </div>
  );
}

function NewChatComposer({ agents, onCreated }: { agents: InstalledAgent[]; onCreated: (thread: ChatThread) => void }): JSX.Element {
  const [agent, setAgent] = useState(agents[0] ? `${agents[0].id}@${agents[0].version}` : "");
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const createMutation = useCreateThreadMutation();
  const sendMutation = useSendChatMutation();
  const pushError = useToastStore((state) => state.pushError);
  const repositories = useRepositoriesQuery();
  const register = useRegisterRepositoryMutation();
  const select = useSelectRepositoryMutation();
  const [projectPath, setProjectPath] = useState("~");
  const [project, setProject] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const directoryQuery = useDirectorySuggestionsQuery(projectPath, projectSearch);
  const selectedRepository = repositories.data?.repositories.find((item) => item.id === repositories.data?.selected_repository_id);
  useEffect(() => {
    if (selectedRepository && !project) { setProject(selectedRepository.path); setProjectPath(selectedRepository.path); }
  }, [selectedRepository, project]);
  const chooseProject = async (path: string): Promise<void> => {
    setProject(path);
    setProjectPath(path);
    setProjectSearch("");
    try {
      const existing = repositories.data?.repositories.find((item) => item.path === path);
      const repo = existing ?? await register.mutateAsync(path);
      await select.mutateAsync(repo.id);
    } catch (error) {
      setProject(null);
      pushError(error instanceof Error ? error.message : "Unable to select this project.");
    }
  };
  const send = async (): Promise<void> => {
    const content = value.trim();
    if (!content || !project || sending) return;
    setSending(true);
    try {
      const [agentId, agentVersion] = agent.split("@");
      const thread = await createMutation.mutateAsync({ agent_id: agentId, agent_version: agentVersion, cwd: project });
      await sendMutation.mutateAsync({ id: thread.id, content });
      onCreated(thread);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Unable to start the conversation.");
    } finally { setSending(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 md:p-8">
      <div className="w-full max-w-2xl">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Start a thread</h1>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">Pick a project and an agent, then describe the work. The conversation is durable — you can leave and come back.</p>
        </div>
        <div className="rounded-2xl border border-border bg-panel shadow-sm">
          <div className="p-3">
            <Textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder="Describe the task for your agent…"
              rows={4}
              disabled={sending || agents.length === 0}
              autoFocus
              className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
            <label className="sr-only" htmlFor="new-chat-agent">Agent</label>
            <select
              id="new-chat-agent"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              className="h-8 min-w-0 max-w-56 rounded-lg border border-input bg-transparent px-2 font-mono text-xs text-text outline-none focus-visible:border-ring"
              disabled={sending || agents.length === 0}
            >
              {agents.map((item) => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.id}@{item.version}</option>)}
            </select>
            <Button type="button" className="ml-auto" onClick={() => void send()} disabled={sending || agents.length === 0 || !project || value.trim().length === 0}>
              {sending ? <LoaderCircle className="animate-spin" aria-hidden /> : <Send aria-hidden />}
              Start thread
            </Button>
          </div>
          <div className="border-t border-border px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm">
              <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                className="rounded-md bg-secondary px-2 py-1 text-xs font-medium hover:bg-secondary/70"
                onClick={() => setProject((current) => current ? null : projectPath)}
              >
                {project ? project.split("/").filter(Boolean).pop() ?? "~" : "Choose project"}
              </button>
              <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">{project ?? "Required — the agent works inside this checkout"}</span>
            </div>
            {!project && (
              <div className="mt-2 rounded-xl border border-border bg-bg p-2">
                <label className="sr-only" htmlFor="project-search">Search projects</label>
                <Input id="project-search" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Search directories…" autoFocus />
                <div className="mt-1 max-h-48 overflow-y-auto">
                  {directoryQuery.data?.directories.map((directory) => (
                    <button key={directory.path} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-secondary" onClick={() => void chooseProject(directory.path)}>
                      <Folder className="size-4 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                      {directory.is_git ? <Badge tone="success">Git</Badge> : <span className="text-xs text-muted-foreground">Open</span>}
                    </button>
                  ))}
                  {directoryQuery.data?.directories.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No directories match here.</p>}
                </div>
                <div className="mt-1 flex items-center justify-between px-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">Searching {directoryQuery.data?.display_path ?? projectPath}</span>
                  <button type="button" className="hover:text-text" onClick={() => { setProject(null); setProjectPath("~"); setProjectSearch(""); }}>Home</button>
                </div>
              </div>
            )}
          </div>
        </div>
        {agents.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Install and probe an agent from the <Link href="/agents" className="text-primary hover:underline">Agents</Link> page before starting a thread.</p>}
        <p className="mt-4 text-xs text-muted-foreground">Enter sends · Shift+Enter adds a new line</p>
      </div>
    </div>
  );
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ChatPane({ thread, seeded, live, permissions, attachments, supportsImages, authMethods, onAttachments, onPermission, loading, loadError, onRetryLoad, onBack, draft, onDraftChange, sending: externalSending, filesOpen, onToggleFiles }: { thread: ChatThread | null; seeded: ChatMessage[]; live: ChatMessage[]; permissions: PendingPermission[]; attachments: ChatAttachment[]; supportsImages: boolean; authMethods: InstalledAgent["auth_methods"]; onAttachments: (items: ChatAttachment[]) => void; onPermission: (requestId: string, action: "approve" | "deny") => Promise<void>; loading: boolean; loadError: string | null; onRetryLoad: () => void; onBack: () => void; draft: string; onDraftChange: (value: string) => void; sending: boolean; filesOpen: boolean; onToggleFiles: () => void }): JSX.Element {
  const pushError = useToastStore((state) => state.pushError);
  const applyChatEvent = useChatStore((state) => state.applyChatEvent);
  const [draftSending, setDraftSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const sendMutation = useSendChatMutation();
  const resubmitMutation = useResubmitChatMutation();
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
      if (result.assistantMessage) applyChatEvent({ type: "thread.message", payload: { threadId: thread.id, message: result.assistantMessage }, timestamp: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The agent could not complete the turn.";
      setSendError(message);
      onDraftChange(content);
    } finally {
      setDraftSending(false);
    }
  };
  const resubmit = async (message: ChatMessage): Promise<void> => {
    if (!thread || draftSending || externalSending) return;
    setDraftSending(true); setSendError(null);
    try { const result = await resubmitMutation.mutateAsync({ id: thread.id, messageId: message.id }); applyChatEvent({ type: "thread.message", payload: { threadId: thread.id, message: result.userMessage }, timestamp: new Date().toISOString() }); if (result.assistantMessage) applyChatEvent({ type: "thread.message", payload: { threadId: thread.id, message: result.assistantMessage }, timestamp: new Date().toISOString() }); }
    catch (error) { setSendError(error instanceof Error ? error.message : "The prompt could not be resubmitted."); }
    finally { setDraftSending(false); }
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

  if (loading) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden />Loading thread…</div>;
  if (loadError || !thread) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><p className="text-sm text-error">{loadError ?? "Thread not found."}</p><Button type="button" variant="outline" onClick={onRetryLoad}><RefreshCw aria-hidden />Retry</Button></div>;

  const busy = draftSending || externalSending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-13 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 md:px-4">
        <Button type="button" size="icon-sm" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to threads" title="Back to threads"><ArrowLeft aria-hidden /></Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold tracking-tight">{thread.title}</h1>
          <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">{thread.agent_id}@{thread.agent_version} · {thread.cwd}</p>
        </div>
        <Badge tone={thread.status === "error" ? "error" : thread.status === "active" ? "success" : "neutral"}>{threadStatusLabel(thread.status)}</Badge>
        <Button type="button" size="icon-sm" variant="outline" className="hidden md:inline-flex" onClick={onToggleFiles} aria-label={filesOpen ? "Hide files" : "Show files"} title={filesOpen ? "Hide files" : "Show files"}>{filesOpen ? <ChevronRight aria-hidden /> : <ChevronLeft aria-hidden />}</Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div ref={listRef} className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-6">
          {messages.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-sm text-muted-foreground">No messages yet. Send one to begin.</p>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={cn("group/msg", message.role === "user" ? "ml-auto max-w-[85%] md:max-w-[75%]" : "w-full")}>
              <div className={cn("mb-1.5 flex items-baseline gap-2 text-[0.6875rem]", message.role === "user" && "justify-end")}>
                <span className={cn("font-semibold tracking-wide uppercase", message.role === "user" ? "text-primary" : "text-muted-foreground")}>
                  {message.role === "user" ? "You" : thread.agent_id}
                </span>
                <span className="text-muted-foreground/70">{formatClock(message.created_at)}</span>
                {message.role === "user" && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 hover:text-text"
                    onClick={() => onDraftChange(message.content)}
                  >
                    <Pencil aria-hidden className="size-3" />Edit
                  </button>
                )}
              </div>
              <div className={cn(message.role === "user" && "rounded-2xl rounded-tr-md border border-primary/15 bg-accent px-4 py-2.5 text-accent-foreground")}>
                {message.attachment_ids.map((id) => <img key={id} src={chatAttachmentUrl(message.thread_id, id)} alt="Attached image" className="mb-2 max-h-64 rounded-lg border object-contain" />)}
                <MarkdownWithCode className="text-sm" src={message.content} />
                {message.prompt_status === "authentication_required" && <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn"><span>Sign in is required. This prompt was preserved and has not been replayed.</span><Button type="button" size="xs" variant="outline" onClick={() => void resubmit(message)} disabled={busy}>Resubmit</Button></div>}
              </div>
            </article>
          ))}
          {permissions.map((request) => <PermissionCard key={request.requestId} request={request} onDecision={onPermission} />)}
          {busy && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Waiting for {thread.agent_id}…
            </p>
          )}
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t border-border bg-panel p-3 md:px-4">
        <div className="mx-auto max-w-3xl">
          {thread.status === "authentication_required" && <div className="mb-2 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn"><p className="font-medium">Sign in required</p><p className="mt-1">Authenticate {thread.agent_id} from the <Link href="/agents" className="underline">Agents page</Link>. Marshal will refresh the session, but will never replay the failed prompt automatically.</p>{authMethods.length > 0 && <p className="mt-1">Available methods: {authMethods.map((method) => method.name).join(", ")}.</p>}</div>}
          {(sendError || thread.status === "error") && (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error">
              <span className="min-w-0">{sendError ?? "The last turn failed."}</span>
              <Button type="button" size="xs" variant="outline" onClick={() => void send(lastPrompt)} disabled={busy || !lastPrompt}><RefreshCw aria-hidden />Retry</Button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="relative">
                  <img src={chatAttachmentUrl(attachment.thread_id, attachment.id)} alt={attachment.filename} className="size-14 rounded-lg border object-cover" />
                  <button type="button" className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-panel p-0.5 text-error shadow-sm" onClick={() => onAttachments(attachments.filter((item) => item.id !== attachment.id))} aria-label={`Remove ${attachment.filename}`}><X className="size-3" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-bg p-2 transition-colors focus-within:border-ring">
            {supportsImages && (
              <>
                <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" onChange={(event) => { if (event.target.files) void upload(event.target.files); event.target.value = ""; }} />
                <Button type="button" size="icon" variant="ghost" onClick={() => inputRef.current?.click()} disabled={uploading || busy} aria-label="Attach image" title="Attach image"><ImagePlus aria-hidden /></Button>
              </>
            )}
            <Textarea
              className="min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder={uploading ? "Uploading image…" : `Message ${thread.agent_id}…`}
              disabled={busy}
              rows={2}
            />
            <Button
              type="button"
              className="h-9 shrink-0 rounded-xl"
              onClick={() => void (busy ? cancel() : send())}
              disabled={!busy && draft.trim().length === 0 && attachments.length === 0}
              variant={busy ? "destructive" : "default"}
            >
              {busy ? <><Square aria-hidden />Stop</> : <><Send aria-hidden />Send</>}
            </Button>
          </div>
          <p className="mt-1.5 text-right text-[0.6875rem] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
        </div>
      </div>
    </div>
  );
}

function PermissionCard({ request, onDecision }: { request: PendingPermission; onDecision: (requestId: string, action: "approve" | "deny") => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const decide = async (action: "approve" | "deny"): Promise<void> => { setBusy(true); await onDecision(request.requestId, action); };
  return (
    <article className="max-w-[92%] rounded-xl border border-warn-border bg-warn-bg px-4 py-3">
      <div className="flex items-center gap-2">
        <ShieldAlert aria-hidden className="size-4 shrink-0 text-warn" />
        <p className="text-sm font-semibold">Permission requested</p>
      </div>
      <p className="mt-1.5 text-sm">The agent wants to <strong>{request.tool}</strong>{request.kind ? <> (<span className="font-mono text-xs">{request.kind}</span>)</> : null}.</p>
      {request.options.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">Options: {request.options.map((option) => `${option.name} [${option.kind}]`).join(" / ")}.</p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="xs" onClick={() => void decide("approve")} disabled={busy || !request.options.some((option) => option.kind === "allow_once")}>Approve once</Button>
        <Button type="button" size="xs" variant="outline" onClick={() => void decide("deny")} disabled={busy || !request.options.some((option) => option.kind === "reject_once")}>Deny</Button>
        <span className="ml-auto text-[0.6875rem] text-muted-foreground">Approval is not process isolation.</span>
      </div>
    </article>
  );
}

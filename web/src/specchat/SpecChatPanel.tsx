import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Send, Snowflake } from "lucide-react";
import { useFreezeTaskMutation, useResubmitSpecMessageMutation, useSendSpecMessageMutation, useSpecAuthorSessionsQuery, useSpecMessagesQuery, useUpdateTaskSpecMutation } from "../api/queries";
import { extractMarshalSpec, MARSHAL_SPEC_FENCE } from "./marshalSpec";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { useTaskStore, selectSpecMessages } from "../state/taskStore";
import { useToastStore } from "../state/toastStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SpecMessage, TaskDetail } from "../types";

interface Props {
  slug: string;
  repositoryId: string | null;
  onSpecUpdated: (task: TaskDetail) => void;
  onFrozen: (task: TaskDetail | null) => void;
}

export function SpecChatPanel({ slug, repositoryId, onSpecUpdated, onFrozen }: Props) {
  const streamed = useTaskStore(useShallow(selectSpecMessages(slug, repositoryId)));
  const applyTaskEvent = useTaskStore((state) => state.applyTaskEvent);
  const sendSpecMessage = useSendSpecMessageMutation();
  const resubmitSpecMessage = useResubmitSpecMessageMutation();
  const updateTaskSpec = useUpdateTaskSpecMutation();
  const freezeTask = useFreezeTaskMutation();
  const pushError = useToastStore((state) => state.pushError);
  const pushInfo = useToastStore((state) => state.pushInfo);
  const messagesQuery = useSpecMessagesQuery(slug, repositoryId);
  const evidenceQuery = useSpecAuthorSessionsQuery(slug, repositoryId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const messages = useMemo<SpecMessage[]>(() => {
    const map = new Map<number, SpecMessage>();
    for (const m of messagesQuery.data ?? []) map.set(m.id, m);
    for (const m of streamed) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [messagesQuery.data, streamed]);

  const proposedSpec = useMemo<string | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const block = extractMarshalSpec(m.content);
      if (block !== null) return block;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    setDismissed(false);
  }, [proposedSpec]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setDraft("");
    try {
      const res = await sendSpecMessage.mutateAsync({ slug, repositoryId: repositoryId!, content: text });
       applyTaskEvent({ type: "spec.message", payload: { taskSlug: slug, repositoryId: repositoryId!, message: res.userMessage }, timestamp: new Date().toISOString() });
       if (res.assistantMessage) applyTaskEvent({ type: "spec.message", payload: { taskSlug: slug, repositoryId: repositoryId!, message: res.assistantMessage }, timestamp: new Date().toISOString() });
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
      setDraft(text);
    } finally {
      setSending(false);
    }
  };
  const resubmit = async (message: SpecMessage): Promise<void> => { if (sending || !repositoryId) return; setSending(true); try { const res = await resubmitSpecMessage.mutateAsync({ slug, repositoryId, messageId: message.id }); applyTaskEvent({ type: "spec.message", payload: { taskSlug: slug, message: res.userMessage }, timestamp: new Date().toISOString() }); if (res.assistantMessage) applyTaskEvent({ type: "spec.message", payload: { taskSlug: slug, message: res.assistantMessage }, timestamp: new Date().toISOString() }); await evidenceQuery.refetch(); } catch (err) { pushError(err instanceof Error ? err.message : String(err)); } finally { setSending(false); } };

  const applySpec = async (): Promise<void> => {
    if (proposedSpec === null || applying) return;
    setApplying(true);
    try {
       const updated = await updateTaskSpec.mutateAsync({ slug, repositoryId: repositoryId!, specMarkdown: proposedSpec });
      if (updated) {
        const { spec_markdown: _spec, last_failure: _failure, ...card } = updated;
        applyTaskEvent({ type: "task.updated", payload: card, timestamp: new Date().toISOString() });
        pushInfo("Spec updated from the latest proposal.");
        onSpecUpdated(updated);
      }
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const freeze = async (): Promise<void> => {
    if (freezing) return;
    setFreezing(true);
    try {
      const result = await freezeTask.mutateAsync({ slug, repositoryId: repositoryId! });
      if (result) onFrozen(result);
    } finally {
      setFreezing(false);
    }
  };

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Discussion with spec author</h3>
      {evidenceQuery.data?.map((session) => (
        <div key={session.id} className="mt-2 rounded-lg border border-border bg-inset px-3 py-2 text-xs text-muted-foreground">
          <strong className="font-medium text-text">Author evidence:</strong> {session.agent_id}@{session.agent_version} · {session.status} · supervisor session {session.supervisor_session_id ?? "not recorded"}
        </div>
      ))}
      {messagesQuery.isPending && <p className="mt-2 text-sm text-muted-foreground">Loading chat…</p>}
      {messagesQuery.error && <p className="mt-2 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error">{messagesQuery.error.message}</p>}
      <ScrollArea className="mt-3 h-72 rounded-lg border border-border bg-inset">
        <div ref={listRef} className="space-y-3 p-3">
          {messages.length === 0 && !messagesQuery.isPending && (
            <p className="py-1 text-sm text-muted-foreground">
              Describe the task and let the agent ask clarifying questions.
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} data-role={m.role}>
              <span className={m.role === "assistant" ? "text-[0.6875rem] font-semibold tracking-wide text-primary uppercase" : "text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase"}>
                {m.role === "assistant" ? "Spec author" : "You"}
              </span>
              <MarkdownWithCode className="text-sm" src={m.content} />
              {m.prompt_status === "authentication_required" && <div className="mt-2 flex items-center justify-between gap-2 rounded border border-warn-border bg-warn-bg px-2 py-1.5 text-xs text-warn"><span>Sign in is required. This exact input was preserved and has not been replayed.</span><Button type="button" size="xs" variant="outline" onClick={() => void resubmit(m)} disabled={sending}>Resubmit</Button></div>}
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="mt-3 flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Ask the agent to refine the spec… (Cmd/Ctrl+Enter to send)"
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="button"
          onClick={() => void send()}
          disabled={sending || draft.trim().length === 0}
          size="sm"
        >
          <Send aria-hidden />
          {sending ? "Thinking…" : "Send"}
        </Button>
      </div>
      {proposedSpec !== null && !dismissed && (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="mb-1.5 text-xs text-muted-foreground">
            Latest proposed spec (from a <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.6875rem]">{MARSHAL_SPEC_FENCE}</code> block):
          </p>
          <pre className="max-h-56 overflow-y-auto rounded-md border border-border bg-panel p-2 font-mono text-xs whitespace-pre-wrap">
            {proposedSpec}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void applySpec()}
              disabled={applying}
            >
              {applying ? "Updating…" : "Update spec"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDismissed(true)} disabled={applying}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      <div className="mt-4 border-t border-border pt-4">
        <Button
          type="button"
          onClick={() => void freeze()}
          disabled={freezing}
          size="sm"
        >
          <Snowflake aria-hidden />
          {freezing ? "Freezing…" : "Freeze to Ready"}
        </Button>
      </div>
    </section>
  );
}

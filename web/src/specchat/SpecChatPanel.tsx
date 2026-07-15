import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Snowflake } from "lucide-react";
import { fetchSpecMessages } from "../api/client";
import { extractMarshalSpec, MARSHAL_SPEC_FENCE } from "./marshalSpec";
import { Markdown } from "../components/Markdown";
import { useBoardContext } from "../board/BoardContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SpecMessage, TaskDetail } from "../types";

interface Props {
  slug: string;
  detail: TaskDetail;
  onSpecUpdated: (task: TaskDetail) => void;
  onFrozen: (task: TaskDetail | null) => void;
}

export function SpecChatPanel({ slug, detail, onSpecUpdated, onFrozen }: Props) {
  const { specMessagesFor, sendSpecMessage, updateTaskSpec, freezeTask, pushError, pushInfo } =
    useBoardContext();
  const streamed = specMessagesFor(slug);
  const [seeded, setSeeded] = useState<SpecMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSeeded([]);
    fetchSpecMessages(slug)
      .then((next) => {
        if (cancelled) return;
        setSeeded(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const messages = useMemo<SpecMessage[]>(() => {
    const map = new Map<number, SpecMessage>();
    for (const m of seeded) map.set(m.id, m);
    for (const m of streamed) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }, [seeded, streamed]);

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
      const res = await sendSpecMessage(slug, text);
      if (res === null) {
        setDraft(text);
      }
    } catch (err) {
      pushError(err instanceof Error ? err.message : String(err));
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  const applySpec = async (): Promise<void> => {
    if (proposedSpec === null || applying) return;
    setApplying(true);
    try {
      const updated = await updateTaskSpec(slug, proposedSpec);
      if (updated) {
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
      const result = await freezeTask(slug, detail, undefined);
      if (result) onFrozen(result);
    } finally {
      setFreezing(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-semibold">Spec Authoring Chat</h3>
      {loading && <p className="text-sm text-muted">Loading chat…</p>}
      {error && <p className="text-sm text-[var(--color-error)]">{error}</p>}
      <ScrollArea className="h-72 rounded-md border border-border bg-bg/30 p-2">
        <div ref={listRef}>
          {messages.length === 0 && !loading && (
            <p className="my-1 text-sm text-muted">
              Describe the task and let the agent ask clarifying questions.
            </p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className="mb-2"
              data-role={m.role}
            >
              <span
                className={
                  m.role === "assistant"
                    ? "text-[0.7rem] font-bold tracking-wider text-[var(--color-success)] uppercase"
                    : "text-[0.7rem] font-bold tracking-wider text-muted uppercase"
                }
              >
                {m.role}
              </span>
              <Markdown className="text-sm" src={m.content} />
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-end gap-2">
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
      {proposedSpec !== null && (
        <div className="rounded-md border border-dashed border-border bg-yellow-50/40 p-2">
          <p className="mb-1.5 text-xs text-muted">
            Latest proposed spec (from a <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.7rem]">{MARSHAL_SPEC_FENCE}</code> block):
          </p>
          <pre className="max-h-56 overflow-y-auto rounded-sm border border-border bg-panel p-1.5 font-mono text-xs whitespace-pre-wrap">
            {proposedSpec}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void applySpec()}
              disabled={applying}
            >
              {applying ? "Updating…" : "Update Spec"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={applying}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      <Separator />
      <div>
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
    </div>
  );
}

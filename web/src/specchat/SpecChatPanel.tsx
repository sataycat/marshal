import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSpecMessages } from "../api/client";
import { extractMarshalSpec, MARSHAL_SPEC_FENCE } from "./marshalSpec";
import { Markdown } from "../components/Markdown";
import { useBoardContext } from "../board/BoardContext";
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

  // Seed from HTTP once when the slug changes so the panel works even before
  // any WebSocket frame has arrived. Subsequent live updates come from the
  // shared bus reducer via specMessagesFor.
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
    <div className="spec-chat">
      <h3>Spec Authoring Chat</h3>
      {loading && <p>Loading chat…</p>}
      {error && <p className="error">{error}</p>}
      <div className="spec-chat-messages" ref={listRef}>
        {messages.length === 0 && !loading && (
          <p className="hint">
            Describe the task and let the agent ask clarifying questions.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`spec-chat-msg spec-chat-${m.role}`}>
            <span className="spec-chat-role">{m.role}</span>
            <Markdown className="spec-chat-content" src={m.content} />
          </div>
        ))}
      </div>
      <div className="spec-chat-composer">
        <textarea
          className="textarea"
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
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void send()}
          disabled={sending || draft.trim().length === 0}
        >
          {sending ? "Thinking…" : "Send"}
        </button>
      </div>
      {proposedSpec !== null && (
        <div className="spec-chat-proposal">
          <p className="spec-chat-proposal-label">
            Latest proposed spec (from a <code>{MARSHAL_SPEC_FENCE}</code> block):
          </p>
          <pre className="spec-chat-proposal-text">{proposedSpec}</pre>
          <div className="spec-chat-proposal-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void applySpec()}
              disabled={applying}
            >
              {applying ? "Updating…" : "Update Spec"}
            </button>
            <button type="button" className="btn btn-secondary" disabled={applying}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className="spec-chat-freeze">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void freeze()}
          disabled={freezing}
        >
          {freezing ? "Freezing…" : "Freeze to Ready"}
        </button>
      </div>
    </div>
  );
}
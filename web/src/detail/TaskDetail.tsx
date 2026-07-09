import { useEffect, useState } from "react";
import { fetchTaskDetail } from "../api/client";
import { renderMarkdown } from "../markdown";
import { useBoardContext } from "../board/BoardContext";
import { actionsForStatus, confirmMessage, type BoardAction } from "../board/actions";
import type { TaskDetail } from "../types";

interface Props {
  slug: string;
  onClose: () => void;
}

export function TaskDetailPanel({ slug, onClose }: Props) {
  const { freezeTask, transitionTask, confirm } = useBoardContext();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetchTaskDetail(slug)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const runAction = async (action: BoardAction): Promise<void> => {
    if (detail === null || busy) return;
    if (action.confirm) {
      const ok = await confirm({ message: confirmMessage(action) });
      if (!ok) return;
    }
    setBusy(true);
    const previous: TaskDetail = detail;
    // Optimistic local update so the panel reflects the new status immediately.
    setDetail({ ...detail, status: action.to });
    try {
      let result: TaskDetail | null;
      if (action.kind === "freeze") {
        result = await freezeTask(slug, previous);
      } else {
        result = await transitionTask(slug, action.to, previous);
      }
      if (result) {
        setDetail(result);
      } else {
        // Mutation helper already rolled back the board and toasted; restore panel.
        setDetail(previous);
      }
    } finally {
      setBusy(false);
    }
  };

  const actions = detail ? actionsForStatus(detail.status) : [];

  return (
    <aside className="detail-panel">
      <header className="detail-header">
        <button className="close" onClick={onClose} type="button">
          Close
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {!detail && !error && <p>Loading…</p>}
      {detail && (
        <div className="detail-body">
          <h2>{detail.title}</h2>
          <p className="slug">{detail.slug}</p>
          <p className="status">
            Status: <strong>{detail.status}</strong>
          </p>
          <p className="retry">Retries: {detail.retry_count}</p>
          {detail.last_failure && (
            <details>
              <summary>Last failure</summary>
              <pre className="failure">{detail.last_failure}</pre>
            </details>
          )}
          <h3>Spec</h3>
          <div
            className="spec"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.spec_markdown) }}
          />
          {actions.length > 0 && (
            <div className="detail-actions">
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className={`btn ${action.confirm ? "btn-warn" : "btn-primary"}`}
                  onClick={() => runAction(action)}
                  disabled={busy}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

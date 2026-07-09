import { useEffect, useState } from "react";
import { fetchTaskDetail } from "../api/client";
import { renderMarkdown } from "../markdown";
import type { TaskDetail } from "../types";

interface Props {
  slug: string;
  onClose: () => void;
}

export function TaskDetailPanel({ slug, onClose }: Props) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        </div>
      )}
    </aside>
  );
}

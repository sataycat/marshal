import { useState } from "react";
import { useBoardContext } from "../board/BoardContext";

interface Props {
  onClose: () => void;
}

export function NewTaskModal({ onClose }: Props) {
  const { createTask, pushError } = useBoardContext();
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      pushError("Title is required.");
      return;
    }
    setSubmitting(true);
    const task = await createTask({
      title: trimmed,
      spec_markdown: spec.trim().length > 0 ? spec : undefined,
    });
    setSubmitting(false);
    if (task) onClose();
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onKeyDown={onKey}>
      <div className="modal new-task-modal">
        <header className="modal-header">
          <h2>New Task</h2>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="text-input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="A short, descriptive task title"
            />
          </label>
          <label className="field">
            <span className="field-label">Spec markdown (optional)</span>
            <textarea
              className="textarea"
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              rows={10}
              placeholder="## Goal&#10;Describe what this task should accomplish."
            />
          </label>
        </div>
        <footer className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create Task"}
          </button>
        </footer>
      </div>
    </div>
  );
}

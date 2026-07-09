import { useEffect } from "react";
import { useBoardContext } from "../board/BoardContext";
import type { Toast } from "./toast";

const AUTO_DISMISS_MS: Record<Toast["kind"], number> = {
  error: 8000,
  info: 4000,
  success: 3000,
};

export function ToastHost() {
  const { toasts, dismissToast } = useBoardContext();
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS[toast.kind]);
    return () => clearTimeout(id);
  }, [toast.kind, onDismiss]);
  return (
    <div className={`toast toast-${toast.kind}`}>
      <span className="toast-message">{toast.message}</span>
      <button className="toast-close" type="button" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

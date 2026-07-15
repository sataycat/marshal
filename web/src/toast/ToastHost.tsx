import { useEffect } from "react";
import { X } from "lucide-react";
import { useBoardContext } from "../board/BoardContext";
import { cn } from "@/lib/utils";
import type { Toast } from "./toast";

const AUTO_DISMISS_MS: Record<Toast["kind"], number> = {
  error: 8000,
  info: 4000,
  success: 3000,
};

export function ToastHost() {
  const { toasts, dismissToast } = useBoardContext();
  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex max-w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}

const TOAST_CLASS: Record<Toast["kind"], string> = {
  error: "bg-[var(--color-error)]",
  info: "bg-blue-900",
  success: "bg-emerald-900",
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS[toast.kind]);
    return () => clearTimeout(id);
  }, [toast.kind, onDismiss]);
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm leading-snug text-white shadow-lg",
        TOAST_CLASS[toast.kind],
      )}
    >
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-0.5 cursor-pointer border-none bg-transparent p-0.5 text-lg leading-none text-inherit"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

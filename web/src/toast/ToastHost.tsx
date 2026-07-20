import { useEffect } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore } from "../state/toastStore";
import { cn } from "@/lib/utils";
import type { Toast } from "./toast";

const AUTO_DISMISS_MS: Record<Toast["kind"], number> = {
  error: 8000,
  info: 4000,
  success: 3000,
};

export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismiss);
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

const TOAST_STYLE: Record<Toast["kind"], { icon: typeof Info; className: string }> = {
  error: { icon: AlertCircle, className: "border-error-border bg-error-bg text-error" },
  info: { icon: Info, className: "border-border bg-popover text-popover-foreground" },
  success: { icon: CheckCircle2, className: "border-success-border bg-success-bg text-success" },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS[toast.kind]);
    return () => clearTimeout(id);
  }, [toast.kind, onDismiss]);
  const { icon: Icon, className } = TOAST_STYLE[toast.kind];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-snug shadow-lg",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1 text-text">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-0.5 cursor-pointer border-none bg-transparent p-0.5 text-muted-foreground hover:text-text"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

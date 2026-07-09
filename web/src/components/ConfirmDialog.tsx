import { useEffect, useRef, useState } from "react";

export interface ConfirmOptions {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
}

interface Pending {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function useConfirm(): ConfirmApi {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = (options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPending({ options, resolve });
    });
  };

  const finish = (result: boolean): void => {
    if (resolver.current) {
      resolver.current(result);
      resolver.current = null;
    }
    setPending(null);
  };

  useEffect(() => {
    if (pending === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") finish(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const dialog =
    pending === null ? null : (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <div className="modal confirm-dialog">
          <p className="confirm-message">{pending.options.message}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => finish(false)}>
              {pending.options.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => finish(true)}
              autoFocus
            >
              {pending.options.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </div>
      </div>
    );

  return { confirm, dialog };
}

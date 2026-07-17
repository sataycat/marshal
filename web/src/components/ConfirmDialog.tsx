import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

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
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending.options.title ?? "Confirm"}</DialogTitle>
            <DialogDescription>{pending.options.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => finish(false)}>
              {pending.options.cancelLabel ?? "Cancel"}
            </Button>
            <Button onClick={() => finish(true)} autoFocus>
              {pending.options.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return { confirm, dialog };
}

export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const api = useConfirm();
  return <ConfirmContext.Provider value={api}>{children}{api.dialog}</ConfirmContext.Provider>;
}

export function useConfirmContext(): Pick<ConfirmApi, "confirm"> {
  const api = useContext(ConfirmContext);
  if (!api) throw new Error("useConfirmContext must be used inside a ConfirmProvider");
  return api;
}

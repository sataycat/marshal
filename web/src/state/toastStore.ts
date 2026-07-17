import { create } from "zustand";
import { addErrorToast, addInfoToast, toastReducer, type Toast } from "../toast/toast";

interface ToastStore {
  toasts: Toast[];
  pushError: (message: string) => void;
  pushInfo: (message: string) => void;
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  pushError: (message) => set((state) => ({ toasts: toastReducer(state.toasts, addErrorToast(message)) })),
  pushInfo: (message) => set((state) => ({ toasts: toastReducer(state.toasts, addInfoToast(message)) })),
  dismiss: (id) => set((state) => ({ toasts: toastReducer(state.toasts, { type: "dismiss", id }) })),
}));

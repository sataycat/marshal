export type ToastKind = "error" | "info" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type ToastState = Toast[];

export type ToastAction =
  | { type: "add"; kind: ToastKind; message: string }
  | { type: "dismiss"; id: number };

let nextToastId = 1;

export function resetToastIdCounter(): void {
  nextToastId = 1;
}

export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "add":
      return [...state, { id: nextToastId++, kind: action.kind, message: action.message }];
    case "dismiss":
      return state.filter((t) => t.id !== action.id);
    default:
      return state;
  }
}

export function addErrorToast(message: string): ToastAction {
  return { type: "add", kind: "error", message };
}

export function addInfoToast(message: string): ToastAction {
  return { type: "add", kind: "info", message };
}

export function addSuccessToast(message: string): ToastAction {
  return { type: "add", kind: "success", message };
}

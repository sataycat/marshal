export function shouldSendDraftKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">): boolean {
  return event.key === "Enter" && !event.shiftKey && (event.metaKey || event.ctrlKey);
}

export function nextDraftAfterSend(retain: boolean): string {
  return retain ? "__retain__" : "";
}

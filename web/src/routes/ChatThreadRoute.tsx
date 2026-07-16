import { ChatSurface } from "../chat/ChatSurface";

interface Props {
  threadId: string;
}

export function ChatThreadRoute({ threadId }: Props): JSX.Element {
  return <ChatSurface selectedId={threadId} />;
}

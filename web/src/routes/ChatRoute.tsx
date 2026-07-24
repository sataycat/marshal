import { ChatSurface } from "../chat/ChatSurface";
import { selectedAgentFromSearch } from "./routes";

export function ChatRoute(): JSX.Element {
  return <ChatSurface selectedAgent={selectedAgentFromSearch(window.location.search)} />;
}

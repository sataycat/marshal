import { Link } from "wouter";
import { ROUTES } from "./routes";

interface Props {
  threadId: string;
}

export function ChatThreadRoute({ threadId }: Props): JSX.Element {
  return (
    <section className="route-placeholder">
      <h2>Thread</h2>
      <p>
        Thread <code>{threadId}</code> is coming soon.
      </p>
      <p>
        <Link href={ROUTES.chat}>Back to chat</Link>
      </p>
    </section>
  );
}

import { Link } from "wouter";
import { ROUTES } from "./routes";

interface Props {
  threadId: string;
}

export function ChatThreadRoute({ threadId }: Props): JSX.Element {
  return (
    <section className="mx-auto my-8 max-w-2xl rounded-lg border border-border bg-panel p-6">
      <h2 className="mb-2 text-lg font-semibold">Thread</h2>
      <p className="my-2 leading-relaxed">
        Thread <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{threadId}</code> is coming soon.
      </p>
      <p className="my-2 leading-relaxed">
        <Link href={ROUTES.chat} className="text-primary hover:underline">
          Back to chat
        </Link>
      </p>
    </section>
  );
}

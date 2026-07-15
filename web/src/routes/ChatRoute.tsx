export function ChatRoute(): JSX.Element {
  return (
    <section className="mx-auto my-8 max-w-2xl rounded-lg border border-border bg-panel p-6">
      <h2 className="mb-2 text-lg font-semibold">Chat</h2>
      <p className="my-2 leading-relaxed">
        The chat surface is coming next. Threads, agent-backed conversations, and
        a code editor are on the way. See ADR-0001a and ADR-0002 for the design.
      </p>
      <p className="my-2 leading-relaxed">
        For now, head over to the <a href="/board" className="text-primary hover:underline">Board</a>.
      </p>
    </section>
  );
}

import { Link } from "wouter";
import { ROUTES } from "./routes";

export function NotFoundRoute(): JSX.Element {
  return (
    <section className="mx-auto my-8 max-w-2xl rounded-lg border border-border bg-panel p-6">
      <h2 className="mb-2 text-lg font-semibold">Not Found</h2>
      <p className="my-2 leading-relaxed">That page does not exist.</p>
      <p className="my-2 leading-relaxed">
        <Link href={ROUTES.board} className="text-primary hover:underline">
          Back to the board
        </Link>
      </p>
    </section>
  );
}

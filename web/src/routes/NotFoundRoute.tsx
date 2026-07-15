import { Link } from "wouter";
import { ROUTES } from "./routes";

export function NotFoundRoute(): JSX.Element {
  return (
    <section className="route-placeholder">
      <h2>Not Found</h2>
      <p>That page does not exist.</p>
      <p>
        <Link href={ROUTES.board}>Back to the board</Link>
      </p>
    </section>
  );
}

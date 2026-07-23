import { Link } from "wouter";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "./routes";
import { cn } from "@/lib/utils";

export function NotFoundRoute(): JSX.Element {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <p className="font-mono text-5xl font-semibold tracking-tight text-muted-foreground/50">404</p>
      <h1 className="mt-3 text-lg font-semibold">That page does not exist</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">The link may be stale, or the session was removed.</p>
      <Link href={ROUTES.chat} className={cn(buttonVariants({ variant: "outline" }), "mt-6")}>
        Back to sessions
      </Link>
    </section>
  );
}

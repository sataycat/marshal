import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { MarshalMark } from "../components/MarshalMark";
import { cn } from "@/lib/utils";

export function RepositorySetup(): JSX.Element {
  return (
    <main className="flex min-h-svh items-center justify-center bg-bg px-4 text-text">
      <section className="w-full max-w-md text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <MarshalMark className="size-6" />
        </span>
        <p className="eyebrow mt-6">First launch</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Connect an agent</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Marshal needs at least one installed, ready agent before you can start a thread. Browse the registry, install one, and authenticate it — all from the browser.
        </p>
        <Link href="/agents" className={cn(buttonVariants({ size: "lg" }), "mt-7 w-full sm:w-auto")}>
          <span>Browse the agent catalog</span>
          <ArrowRight aria-hidden />
        </Link>
      </section>
    </main>
  );
}

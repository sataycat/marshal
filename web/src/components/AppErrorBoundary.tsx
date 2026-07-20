import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Marshal UI render error", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;

    return (
      <main className="flex min-h-[50vh] items-center justify-center p-6">
        <section className="max-w-lg rounded-lg border border-error/30 bg-panel p-6 shadow-sm">
          <h1 className="text-lg font-semibold">This page could not be rendered</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Reload the page to try again. If the problem persists, send this detail to the operator:
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <Button type="button" className="mt-4" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </section>
      </main>
    );
  }
}

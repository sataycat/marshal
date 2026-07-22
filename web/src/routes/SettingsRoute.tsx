import { ThemeSettings } from "../components/ThemeSettings";
import { PageHeader } from "../components/PageHeader";
import { DiagnosticsRoute } from "./DiagnosticsRoute";

export function SettingsRoute(): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-5xl overflow-y-auto px-4 py-6 md:px-8">
      <PageHeader
        eyebrow="Marshal"
        title="Settings"
        description="Manage workspace appearance and inspect the health of your local Marshal installation."
      />
      <div className="mt-6 space-y-8">
        <ThemeSettings />
        <DiagnosticsRoute embedded />
      </div>
    </div>
  );
}

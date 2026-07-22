import { Monitor, Moon, Palette, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "../theme";

const options: Array<{ mode: ThemeMode; label: string; description: string; icon: typeof Monitor }> = [
  { mode: "system", label: "System", description: "Follow your operating system preference", icon: Monitor },
  { mode: "dracula", label: "Dark", description: "Low-glare workspace for focused sessions", icon: Moon },
  { mode: "alucard", label: "Light", description: "High-contrast daylight workspace", icon: Sun },
];

export function ThemeSettings(): JSX.Element {
  const { mode, setMode } = useTheme();

  return (
    <section className="rounded-xl border border-border bg-panel p-4 md:p-5" aria-labelledby="appearance-heading">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Palette aria-hidden className="size-4" />
        </span>
        <div>
          <h2 id="appearance-heading" className="text-sm font-semibold">Appearance</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose how Marshal should look. System follows your device automatically.</p>
        </div>
      </div>
      <fieldset className="mt-4 grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">Theme</legend>
        {options.map(({ mode: optionMode, label, description, icon: Icon }) => (
          <label
            key={optionMode}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name="theme"
              value={optionMode}
              checked={mode === optionMode}
              onChange={() => setMode(optionMode)}
              className="sr-only"
            />
            <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

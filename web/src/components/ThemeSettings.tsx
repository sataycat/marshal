import { Monitor, Moon, Palette, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "../theme";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

const options: Array<{ mode: ThemeMode; label: string; description: string; icon: typeof Monitor }> = [
  { mode: "system", label: "System", description: "Follow your operating system preference", icon: Monitor },
  { mode: "dracula", label: "Dark", description: "Low-glare workspace for focused sessions", icon: Moon },
  { mode: "alucard", label: "Light", description: "High-contrast daylight workspace", icon: Sun },
];

export function ThemeSettings(): JSX.Element {
  const { mode, setMode } = useTheme();

  return (
    <Dialog>
      <DialogTrigger
        render={<Button type="button" variant="ghost" size="icon" />}
        aria-label="Open settings"
        title="Settings"
      >
        <Palette aria-hidden />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Choose how Marshal should look. System follows your device automatically.</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">Appearance</legend>
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
                <span className="mt-0.5 block text-xs text-muted">{description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}

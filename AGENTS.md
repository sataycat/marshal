# Toolchain: use `vp`, not npm/pnpm/vite

This repo uses **Vite+**. The CLI is **`vp`**. You likely were not trained on it — **do not guess** familiar commands.

**Do not run:** `npm`, `pnpm`, `yarn`, `npx`, `vite`, `vitest`, `eslint`, `prettier` directly.

Use `vp` for everything:

- Install: `vp install`
- Dev: `vp dev`
- Build: `vp build`
- Test: `vp test`
- Format, lint, type-check: `vp check`
- Custom `package.json` scripts: `vp run <script>` (not `pnpm run`)
- Staged pre-commit checks: `vp staged`
- Help: `vp help` · `vp <command> --help` · `node_modules/vite-plus/docs`

Before finishing: `vp install` (after pull) → `vp check && vp test` → any extra `vp run …` scripts. If env/setup looks wrong: `vp env doctor`.

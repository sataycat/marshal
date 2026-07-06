# Toolchain

Use standard package-manager commands for development. The repo pins `pnpm@11.10.0` via `packageManager`.

- Install: `pnpm install`
- Build: `pnpm run build`
- Test: `pnpm run test`
- Type-check: `pnpm run check`
- Custom `package.json` scripts: `pnpm run <script>`

## Pre-commit hooks

Vite+ is still used only for staged pre-commit formatting and linting:

- Staged pre-commit checks: `vp staged`

Run `pnpm install` (after pull) → `pnpm run check && pnpm run test` → any extra `pnpm run …` scripts before finishing.

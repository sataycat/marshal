import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "web/**"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
      shuffle: false,
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Disable fsmonitor for test repos — the daemon can't serve temp dirs and
      // the IPC fallback adds ~200-500ms per git command on macOS, enough to
      // push heavy-git tests past their timeouts.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
    },
  },
});

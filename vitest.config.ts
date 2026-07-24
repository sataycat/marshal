import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "web/**"],
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 4,
    sequence: {
      concurrent: false,
      shuffle: false,
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    env: {
      // Disable fsmonitor for test repos — the daemon can't serve temp dirs and
      // the IPC fallback adds ~200-500ms per git command on macOS, enough to
      // push heavy-git tests past their timeouts.
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "commit.gpgSign",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  },
});

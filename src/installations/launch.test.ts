import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.fn(() => {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("exit", 0));
  return child;
});
vi.mock("node:child_process", () => ({ spawn }));

describe("package launch safety", () => {
  it("launches npx without shell interpolation", async () => {
    const { runNpx } = await import("./installer.js");
    await runNpx("demo@1.2.3", "/tmp");
    expect(spawn).toHaveBeenCalledWith("npx", ["--yes", "--package", "demo@1.2.3", "node", "-e", ""], expect.objectContaining({ shell: false }));
  });

  it("launches uvx without shell interpolation", async () => {
    const { runUvx } = await import("./installer.js");
    await runUvx("demo==1.2.3", "/tmp");
    expect(spawn).toHaveBeenCalledWith("uvx", ["--from", "demo==1.2.3", "demo", "--help"], expect.objectContaining({ shell: false }));
  });
});

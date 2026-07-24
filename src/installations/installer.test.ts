import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  cancelInstallationOperation,
  exactNpxPackage,
  exactUvxPackage,
  installBinary,
  installCandidate,
  selectDistribution,
  startInstallation,
} from "./installer.js";
import {
  createInstallation,
  getInstalledAgent,
  getInstallationOperation,
  reconcileInstallationOperations,
} from "../agents/store.js";
import { openMachineDb } from "../storage/machine.js";
import type { RegistryAgent } from "../registry/types.js";

const uvxAgent: RegistryAgent = {
  id: "uv-agent",
  name: "UV Agent",
  version: "1.2.3",
  description: "fixture",
  license: "MIT",
  authors: [],
  distributions: [{ kind: "uvx", package: "uv-agent==1.2.3", args: ["acp"] }],
};

describe("uvx installations", () => {
  function binaryTar(executable = "bin/agent"): Uint8Array {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(executable), 0);
    header.set(new TextEncoder().encode("00000000011\0"), 124);
    header[156] = 48;
    const body = new TextEncoder().encode("#!/bin/sh\n");
    const out = new Uint8Array(1024 + 512);
    out.set(header);
    out.set(body, 512);
    return gzipSync(out);
  }
  function binaryOperation(machineDir: string, operationId: string, executable = "bin/agent") {
    return createInstallation(
      {
        id: "binary",
        version: "1.0.0",
        source: "registry",
        license: "MIT",
        distribution: "binary",
        package_specifier: "archive",
        launch: { command: "pending", args: [] },
        registry_snapshot_fetched_at: "fixture",
        integrity_status: "unknown",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
        provenance: {
          exact_version: "1.0.0",
          distribution: "binary",
          source: "registry",
          package_specifier: null,
          archive_identity: "fixture://binary",
          registry_snapshot_fetched_at: "fixture",
          installation_root: `${machineDir}/agents/binary/1.0.0/published`,
          integrity_status: "unknown",
        },
        installation_id: "binary-install",
        installation_root: `${machineDir}/agents/binary/1.0.0/published`,
      },
      operationId,
      machineDir,
      {
        temporary_root: `${machineDir}/agents/.tmp-binary`,
        published_root: `${machineDir}/agents/binary/1.0.0/published`,
      },
    );
  }

  it("verifies binary checksums and refuses mismatches", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-binary-integrity-`);
    const bytes = binaryTar();
    const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    binaryOperation(machineDir, "binary-match");
    await installBinary(
      {
        id: "binary",
        name: "Binary",
        version: "1.0.0",
        description: "fixture",
        license: "MIT",
        authors: [],
        distributions: [],
      },
      {
        kind: "binary",
        archive_url: "https://fixture/binary.tgz",
        archive_format: "tgz",
        executable: "bin/agent",
        checksum: digest,
      },
      machineDir,
      "binary-match",
      false,
      async () => new Response(bytes),
    );
    expect(getInstallationOperation("binary-match", machineDir)).toMatchObject({
      status: "installed",
      phase: "completed",
    });
    binaryOperation(machineDir, "binary-mismatch");
    await installBinary(
      {
        id: "binary",
        name: "Binary",
        version: "1.0.0",
        description: "fixture",
        license: "MIT",
        authors: [],
        distributions: [],
      },
      {
        kind: "binary",
        archive_url: "https://fixture/binary.tgz",
        archive_format: "tgz",
        executable: "bin/agent",
        checksum: "b".repeat(64),
      },
      machineDir,
      "binary-mismatch",
      false,
      async () => new Response(bytes),
    );
    expect(getInstallationOperation("binary-mismatch", machineDir)).toMatchObject({
      status: "failed",
      error_code: "integrity_mismatch",
    });
  });

  it("requires confirmation for checksumless binaries and rejects escaping executables", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-binary-policy-`);
    const bytes = binaryTar();
    binaryOperation(machineDir, "binary-unverified");
    await installBinary(
      {
        id: "binary",
        name: "Binary",
        version: "1.0.0",
        description: "fixture",
        license: "MIT",
        authors: [],
        distributions: [],
      },
      {
        kind: "binary",
        archive_url: "https://fixture/binary.tgz",
        archive_format: "tgz",
        executable: "bin/agent",
      },
      machineDir,
      "binary-unverified",
      false,
      async () => new Response(bytes),
    );
    expect(getInstallationOperation("binary-unverified", machineDir)).toMatchObject({
      status: "failed",
      error_code: "unverified_binary",
    });
    binaryOperation(machineDir, "binary-escape", "../escape");
    await installBinary(
      {
        id: "binary",
        name: "Binary",
        version: "1.0.0",
        description: "fixture",
        license: "MIT",
        authors: [],
        distributions: [],
      },
      {
        kind: "binary",
        archive_url: "https://fixture/binary.tgz",
        archive_format: "tgz",
        executable: "../escape",
      },
      machineDir,
      "binary-escape",
      true,
      async () => new Response(bytes),
    );
    expect(getInstallationOperation("binary-escape", machineDir)).toMatchObject({
      status: "failed",
      error_code: "unsafe_archive",
    });
  });

  it("uses lifecycle distribution precedence and honors an explicit override", () => {
    const agent: RegistryAgent = {
      id: "precedence",
      name: "Precedence",
      version: "1.2.3",
      description: "fixture",
      license: "MIT",
      authors: [],
      distributions: [
        {
          kind: "binary",
          platforms: ["darwin-aarch64"],
          archive_url: "https://example.invalid/darwin.tgz",
          archive_format: "tgz",
          checksum: "b".repeat(64),
          executable: "agent",
        },
        {
          kind: "binary",
          platforms: ["linux-x64"],
          archive_url: "https://example.invalid/unverified.tgz",
          archive_format: "tgz",
          executable: "agent",
        },
        {
          kind: "binary",
          platforms: ["linux-x64"],
          archive_url: "https://example.invalid/verified.tgz",
          archive_format: "tgz",
          checksum: "a".repeat(64),
          executable: "agent",
        },
        { kind: "npx", package: "precedence@1.2.3" },
        { kind: "uvx", package: "precedence==1.2.3" },
      ],
    };
    expect(selectDistribution(agent, "linux-x64").archive_url).toContain("verified");
    expect(selectDistribution(agent, "darwin-arm64").archive_url).toContain("darwin");
    expect(selectDistribution(agent, "linux-arm64").kind).toBe("npx");
    expect(selectDistribution(agent, "linux-x64", "npx").kind).toBe("npx");
    expect(selectDistribution(agent, "linux-x64", "uvx").kind).toBe("uvx");
    expect(installCandidate(agent, "linux-x64", "binary")).toMatchObject({
      checksum: "a".repeat(64),
      integrity_policy: "verified_if_declared",
    });
  });

  it("persists binary installations without a package specifier", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-binary-start-`);
    const agent: RegistryAgent = {
      id: "binary-agent",
      name: "Binary Agent",
      version: "1.0.0",
      description: "fixture",
      license: "MIT",
      authors: [],
      distributions: [
        {
          kind: "binary",
          platforms: [`${process.platform}-${process.arch}`],
          archive_url: "https://fixture/binary.tgz",
          archive_format: "tgz",
          executable: "agent",
          checksum: "a".repeat(64),
        },
      ],
    };
    const operation = await startInstallation(agent, machineDir, undefined, undefined, {
      fetch: async () => new Response(new Uint8Array()),
    });
    expect(operation.package_specifier).toBeNull();
    expect(getInstallationOperation(operation.id, machineDir)).toMatchObject({
      package_specifier: null,
    });
    expect(getInstalledAgent(agent.id, agent.version, machineDir)?.package_specifier).toBeNull();
  });

  it("accepts only exact package launch pins for both package distributions", () => {
    expect(exactNpxPackage("precedence@1.2.3")).toBe("precedence@1.2.3");
    expect(exactUvxPackage("precedence==1.2.3")).toBe("precedence==1.2.3");
  });

  it("cancels before publication, cleans the temporary root, and remains retryable", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-cancel-`);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = await startInstallation(uvxAgent, machineDir, async () => waiting);
    const cancelled = cancelInstallationOperation(operation.id, machineDir);
    expect(cancelled).toMatchObject({
      status: "interrupted",
      phase: "interrupted",
      error_code: "installation_cancelled",
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(cancelled.temporary_root ?? "")).toBe(false);
    const retry = await startInstallation(uvxAgent, machineDir, async () => undefined, undefined, {
      retry: true,
    });
    expect(retry.id).not.toBe(operation.id);
  });

  it("rejects moving aliases and preserves exact package pins", () => {
    expect(exactUvxPackage("uv-agent==1.2.3")).toBe("uv-agent==1.2.3");
    for (const value of [
      "uv-agent",
      "uv-agent==latest",
      "uv-agent==main",
      "uv-agent==1.2",
      "uv-agent==1.2.3 foo",
    ]) {
      expect(() => exactUvxPackage(value)).toThrow(/exact package/);
    }
  });

  it("selects uvx fallback and persists a no-install launch specification", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-uvx-`);
    const seen: string[] = [];
    const operation = await startInstallation(uvxAgent, machineDir, async (specifier, cwd) => {
      seen.push(`${specifier}:${cwd}`);
    });
    expect(selectDistribution(uvxAgent).kind).toBe("uvx");
    expect(seen).toHaveLength(1);
    const installed = getInstalledAgent("uv-agent", "1.2.3", machineDir);
    expect(installed?.package_specifier).toBe("uv-agent==1.2.3");
    expect(installed?.launch).toEqual({
      command: "uvx",
      args: ["--from", "uv-agent==1.2.3", "uv-agent", "acp"],
    });
    expect(installed?.provenance).toMatchObject({
      distribution: "uvx",
      package_specifier: "uv-agent==1.2.3",
    });
    expect(operation.status).toBe("installing");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getInstalledAgent("uv-agent", "1.2.3", machineDir)?.status).toBe("installed");
  });

  it("publishes through a unique root and reuses duplicate identity", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-atomic-`);
    const first = await startInstallation(uvxAgent, machineDir, async (_specifier, cwd) => {
      const marker = `${cwd}/payload`;
      await import("node:fs").then(({ writeFileSync }) => writeFileSync(marker, "ok"));
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await startInstallation(uvxAgent, machineDir, async () => {
      throw new Error("duplicate must not run");
    });
    expect(second.id).toBe(first.id);
    const operation = getInstallationOperation(first.id, machineDir)!;
    expect(operation.phase).toBe("completed");
    expect(operation.published_root).toContain("/agents/uv-agent/1.2.3/");
    expect(operation.published_root).not.toBe(operation.temporary_root);
    expect(existsSync(`${operation.published_root}/manifest.json`)).toBe(true);
    expect(
      JSON.parse(readFileSync(`${operation.published_root}/manifest.json`, "utf8")).installation_id,
    ).toContain("uv-agent@1.2.3:uvx:");
  });

  it("reinstalls when a completed operation has lost its installed-agent row", async () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-stale-installation-`);
    const first = await startInstallation(uvxAgent, machineDir, async (_specifier, cwd) => {
      await import("node:fs").then(({ writeFileSync }) => writeFileSync(`${cwd}/payload`, "first"));
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getInstalledAgent("uv-agent", "1.2.3", machineDir)).toBeDefined();
    openMachineDb(machineDir)
      .prepare("DELETE FROM installed_agents WHERE id = ? AND version = ? AND installation_id = ?")
      .run("uv-agent", "1.2.3", first.installation_id);

    const second = await startInstallation(uvxAgent, machineDir, async (_specifier, cwd) => {
      await import("node:fs").then(({ writeFileSync }) =>
        writeFileSync(`${cwd}/payload`, "second"),
      );
    });
    expect(second.id).not.toBe(first.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getInstalledAgent("uv-agent", "1.2.3", machineDir)?.status).toBe("installed");
  });

  it("marks incomplete operations interrupted and cleans temporary roots on recovery", () => {
    const machineDir = mkdtempSync(`${tmpdir()}/marshal-recovery-`);
    const created = createInstallation(
      {
        id: "uv-agent",
        version: "1.2.3",
        source: "registry",
        license: "MIT",
        distribution: "uvx",
        package_specifier: "uv-agent==1.2.3",
        launch: { command: "uvx", args: ["--from", "uv-agent==1.2.3", "uv-agent"] },
        registry_snapshot_fetched_at: null,
        integrity_status: "not_applicable",
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
      },
      "recovery-op",
      machineDir,
      {
        temporary_root: `${machineDir}/agents/.tmp-stale`,
        published_root: `${machineDir}/agents/uv-agent/1.2.3/stale`,
      },
    );
    reconcileInstallationOperations(machineDir);
    const recovered = getInstallationOperation(created.id, machineDir)!;
    expect(recovered.status).toBe("interrupted");
    expect(recovered.phase).toBe("interrupted");
    expect(recovered.error).toMatch(/interrupted/i);
  });
});

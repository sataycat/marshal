import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * The daemon's filesystem boundary.
 *
 * This module deliberately does not open databases or know about repository
 * checkouts.  It only resolves names owned by the daemon and provides the
 * small amount of validation needed before those names become paths.
 */
export const DEFAULT_MARSHAL_HOME = resolve(homedir(), ".marshal");
export const STORAGE_DIRECTORY_MODE = 0o700;
export const STORAGE_FILE_MODE = 0o600;

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoragePathError";
  }
}

export interface RepositoryNamespace {
  root: string;
  attachmentsDirectory: string;
  artifactsDirectory: string;
  worktreesDirectory: string;
}

export interface StorageLayout {
  /** The resolved MARSHAL_HOME boundary. */
  root: string;
  /** The canonical database path for the consolidated-storage cutover. */
  databasePath: string;
  /** Alias useful at call sites that use the ADR's name. */
  marshalDbPath: string;
  registryDirectory: string;
  installationsDirectory: string;
  credentialsDirectory: string;
  repositoriesDirectory: string;
  logsDirectory: string;
  temporaryDirectory: string;
  /** Existing daemon-wide worktree location; repository worktree migration is a later slice. */
  legacyWorktreesDirectory: string;
  configPath: string;
  daemonPidPath: string;
  daemonPortPath: string;
  installationDirectory(agentId: string, version: string, installationId: string): string;
  credentialFile(referenceId: string): string;
  repositoryNamespace(repositoryId: string): RepositoryNamespace;
  temporaryFile(name: string): string;
}

export type StorageRoot = string | undefined;

export function defaultMarshalHome(): string {
  return resolve(homedir(), ".marshal");
}

/** Resolve an explicit root, MARSHAL_HOME, or the default home in that order. */
export function resolveMarshalHome(explicitRoot?: string): string {
  const configured = explicitRoot ?? process.env.MARSHAL_HOME;
  return resolve(configured && configured.trim() !== "" ? configured : defaultMarshalHome());
}

/**
 * Namespace components are intentionally narrower than arbitrary filesystem
 * paths.  Registry IDs and versions must pass this check before they can be
 * used as directory names; repository and installation IDs are normally
 * daemon-generated UUIDs and pass it as well.
 */
export function validateNamespaceComponent(value: string, label = "namespace component"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._+@~:-]*$/.test(value)
  ) {
    throw new StoragePathError(`${label} must be a safe single path component`);
  }
  return value;
}

/**
 * Convert a logical identifier into one safe path component.  ACP Registry
 * identifiers may be scoped (for example `@example/agent`), while a slash is
 * never allowed to become a directory separator.  Percent is excluded from
 * ordinary components, so this encoding cannot collide with an unencoded one.
 */
function namespaceComponent(value: string, label: string, allowSlash = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0") ||
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    (!allowSlash && value.includes("/"))
  ) {
    throw new StoragePathError(`${label} must be a safe identifier`);
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._+@~:-]*$/.test(value)) return value;
  if (allowSlash && /^[A-Za-z0-9@._+~:/-]+$/.test(value)) return encodeURIComponent(value);
  throw new StoragePathError(`${label} must be a safe identifier`);
}

function assertPathContained(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const lexicalRelative = relative(resolvedRoot, resolvedCandidate);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new StoragePathError(`Resolved path escapes MARSHAL_HOME: ${candidate}`);
  }

  // Lexical checks stop traversal attacks.  Also check the real path of the
  // nearest existing ancestor so a symlink in a partially-created home cannot
  // redirect a new daemon-owned namespace outside the boundary.
  const nearestExisting = (path: string): string => {
    let current = path;
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
    return current;
  };
  const realRoot = realpathSync(nearestExisting(resolvedRoot));
  const candidateAncestor = nearestExisting(resolvedCandidate);
  const realCandidateAncestor = realpathSync(candidateAncestor);
  const physicalRelative = relative(realRoot, realCandidateAncestor);
  if (physicalRelative.startsWith("..") || isAbsolute(physicalRelative)) {
    throw new StoragePathError(`Resolved path follows a symlink outside MARSHAL_HOME: ${candidate}`);
  }
  return resolvedCandidate;
}

function child(root: string, ...components: string[]): string {
  return assertPathContained(root, resolve(root, ...components));
}

function fixedChild(root: string, ...components: string[]): string {
  return child(root, ...components);
}

/** Resolve all paths without creating the storage root. */
export function storageLayout(explicitRoot?: string): StorageLayout {
  const root = resolveMarshalHome(explicitRoot);
  const registryDirectory = fixedChild(root, "registry");
  const installationsDirectory = fixedChild(root, "agents");
  const credentialsDirectory = fixedChild(root, "credentials");
  const repositoriesDirectory = fixedChild(root, "repositories");
  const logsDirectory = fixedChild(root, "logs");
  const temporaryDirectory = fixedChild(root, "tmp");

  return {
    root,
    databasePath: fixedChild(root, "marshal.db"),
    marshalDbPath: fixedChild(root, "marshal.db"),
    registryDirectory,
    installationsDirectory,
    credentialsDirectory,
    repositoriesDirectory,
    logsDirectory,
    temporaryDirectory,
    legacyWorktreesDirectory: fixedChild(root, "worktrees"),
    configPath: fixedChild(root, "config.json"),
    daemonPidPath: fixedChild(root, "daemon.pid"),
    daemonPortPath: fixedChild(root, "daemon.port"),
    installationDirectory(agentId, version, installationId) {
      return child(
        root,
        "agents",
        namespaceComponent(agentId, "agent id", true),
        namespaceComponent(version, "agent version"),
        namespaceComponent(installationId, "installation id"),
      );
    },
    credentialFile(referenceId) {
      return child(
        root,
        "credentials",
        namespaceComponent(referenceId, "credential reference"),
      );
    },
    repositoryNamespace(repositoryId) {
      const id = namespaceComponent(repositoryId, "repository id");
      const repositoryRoot = child(root, "repositories", id);
      return {
        root: repositoryRoot,
        attachmentsDirectory: child(root, "repositories", id, "attachments"),
        artifactsDirectory: child(root, "repositories", id, "artifacts"),
        worktreesDirectory: child(root, "repositories", id, "worktrees"),
      };
    },
    temporaryFile(name) {
      return child(root, "tmp", validateNamespaceComponent(name, "temporary file"));
    },
  };
}

function ensureDirectory(path: string, mode = STORAGE_DIRECTORY_MODE): string {
  mkdirSync(path, { recursive: true, mode });
  // mkdir's mode is ignored for an existing directory.  Daemon-owned
  // directories must remain private even when a previous process created them.
  chmodSync(path, mode);
  return path;
}

/** Create the fixed daemon-owned directories with restrictive permissions. */
export function ensureStorageLayout(explicitRoot?: string): StorageLayout {
  const layout = storageLayout(explicitRoot);
  ensureDirectory(layout.root);
  ensureDirectory(layout.registryDirectory);
  ensureDirectory(layout.installationsDirectory);
  ensureDirectory(layout.credentialsDirectory);
  ensureDirectory(layout.repositoriesDirectory);
  ensureDirectory(layout.logsDirectory);
  ensureDirectory(layout.temporaryDirectory);
  ensureDirectory(layout.legacyWorktreesDirectory);
  return layout;
}

export function ensureInstallationDirectory(
  agentId: string,
  version: string,
  installationId: string,
  explicitRoot?: string,
): string {
  const layout = ensureStorageLayout(explicitRoot);
  const directory = layout.installationDirectory(agentId, version, installationId);
  return ensureDirectory(directory);
}

export function ensureRepositoryNamespace(
  repositoryId: string,
  explicitRoot?: string,
): RepositoryNamespace {
  const layout = ensureStorageLayout(explicitRoot);
  const namespace = layout.repositoryNamespace(repositoryId);
  ensureDirectory(namespace.root);
  ensureDirectory(namespace.attachmentsDirectory);
  ensureDirectory(namespace.artifactsDirectory);
  ensureDirectory(namespace.worktreesDirectory);
  return namespace;
}

/** Create a daemon-owned temporary directory under MARSHAL_HOME/tmp. */
export function createStorageTemporaryDirectory(prefix: string, explicitRoot?: string): string {
  const safePrefix = validateNamespaceComponent(prefix, "temporary directory prefix");
  const layout = ensureStorageLayout(explicitRoot);
  const directory = mkdtempSync(join(layout.temporaryDirectory, `${safePrefix}-`));
  assertPathContained(layout.root, directory);
  chmodSync(directory, STORAGE_DIRECTORY_MODE);
  return directory;
}

/** Assert that an existing or planned path belongs to a storage root. */
export function assertStoragePath(explicitRoot: string, candidate: string): string {
  return assertPathContained(resolveMarshalHome(explicitRoot), candidate);
}

function assertWithinDirectory(explicitRoot: string, base: string, candidate: string, label: string): string {
  const layout = storageLayout(explicitRoot);
  const resolvedBase = resolve(base);
  const resolvedCandidate = assertPathContained(layout.root, candidate);
  const childRelative = relative(resolvedBase, resolvedCandidate);
  if (childRelative === "" || childRelative.startsWith("..") || isAbsolute(childRelative)) {
    throw new StoragePathError(`${label} is outside its Marshal-owned namespace: ${candidate}`);
  }
  return resolvedCandidate;
}

export function assertInstallationPath(explicitRoot: string, candidate: string): string {
  return assertWithinDirectory(
    explicitRoot,
    storageLayout(explicitRoot).installationsDirectory,
    candidate,
    "Installation path",
  );
}

export function assertTemporaryPath(explicitRoot: string, candidate: string): string {
  const layout = storageLayout(explicitRoot);
  const contained = assertPathContained(layout.root, candidate);
  const temporaryRelative = relative(layout.temporaryDirectory, contained);
  if (temporaryRelative !== "" && !temporaryRelative.startsWith("..") && !isAbsolute(temporaryRelative)) {
    return contained;
  }
  // Operations created before Slice 1 may still contain an agents/.tmp path
  // in their durable recovery metadata.  It remains daemon-owned and is
  // accepted only for recovery/cleanup; new temporary directories use tmp/.
  const legacyRelative = relative(layout.installationsDirectory, contained);
  if (legacyRelative === "" || legacyRelative.startsWith("..") || isAbsolute(legacyRelative) || !legacyRelative.startsWith(".tmp")) {
    throw new StoragePathError(`Temporary path is outside its Marshal-owned namespace: ${candidate}`);
  }
  return contained;
}

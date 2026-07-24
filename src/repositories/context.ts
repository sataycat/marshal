import { resolve } from "node:path";
import { getGlobalDir } from "../daemon/config.js";
import { getRepository, repositoryIsAvailable, type Repository } from "./store.js";

/**
 * Explicit repository ownership plus checkout metadata needed by execution.
 * Store queries must use `id`; `checkoutPath` is never an authorization key.
 */
export interface RepositoryContext {
  id: string;
  checkoutPath: string;
  name: string;
}

export type RepositoryContextErrorCode = "repository_not_found" | "repository_unavailable" | "repository_unregistered";

export class RepositoryContextError extends Error {
  constructor(readonly code: RepositoryContextErrorCode, message: string) {
    super(message);
    this.name = "RepositoryContextError";
  }
}

/** Resolve a registered repository ID without consulting browser selection. */
export function resolveRepositoryContext(
  repositoryId: string,
  machineDir = getGlobalDir(),
): RepositoryContext {
  if (typeof repositoryId !== "string" || repositoryId.trim().length === 0) {
    throw new RepositoryContextError("repository_not_found", "Repository ID is required");
  }
  const repository = getRepository(repositoryId, machineDir);
  if (!repository) {
    throw new RepositoryContextError(
      "repository_not_found",
      `Repository not found: ${repositoryId}`,
    );
  }
  if (repository.registration_status === "unregistered")
    throw new RepositoryContextError("repository_unregistered", `Repository ${repository.id} is unregistered; reconnect its checkout before performing source-dependent actions`);
  if (!repositoryIsAvailable(repository))
    throw new RepositoryContextError("repository_unavailable", `Repository checkout is unavailable at ${repository.path}; reconnect it before performing source-dependent actions`);
  return { id: repository.id, checkoutPath: resolve(repository.path), name: repository.name };
}

export function resolveRepositoryRecord(repositoryId: string, machineDir = getGlobalDir()): Repository {
  if (typeof repositoryId !== "string" || repositoryId.trim().length === 0)
    throw new RepositoryContextError("repository_not_found", "Repository ID is required");
  const repository = getRepository(repositoryId, machineDir);
  if (!repository) throw new RepositoryContextError("repository_not_found", `Repository not found: ${repositoryId}`);
  return repository;
}

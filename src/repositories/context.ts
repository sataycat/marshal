import { resolve } from "node:path";
import { getGlobalDir } from "../daemon/config.js";
import { getRepository } from "./store.js";

/**
 * Explicit repository ownership plus checkout metadata needed by execution.
 * Store queries must use `id`; `checkoutPath` is never an authorization key.
 */
export interface RepositoryContext {
  id: string;
  checkoutPath: string;
  name: string;
}

export type RepositoryContextErrorCode = "repository_not_found" | "repository_unavailable";

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
  return { id: repository.id, checkoutPath: resolve(repository.path), name: repository.name };
}

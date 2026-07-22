import { RequestError } from "@agentclientprotocol/sdk";

export type AcpFailureKind =
  | "authentication_required"
  | "cancelled"
  | "resource_not_found"
  | "protocol_incompatible"
  | "process_start_failed"
  | "timeout"
  | "agent_internal_error";

export interface StructuredAcpError {
  kind: AcpFailureKind;
  message: string;
  protocol_code: number | null;
  data: unknown;
}

export class StructuredAcpFailureError extends Error {
  constructor(public readonly failure: StructuredAcpError) {
    super(failure.message);
    this.name = "StructuredAcpFailureError";
  }
}

const AUTH_REQUIRED_CODE = RequestError.authRequired().code;
const REQUEST_CANCELLED_CODE = RequestError.requestCancelled().code;
const RESOURCE_NOT_FOUND_CODE = RequestError.resourceNotFound().code;

export function structuredAcpError(error: unknown): StructuredAcpError {
  if (error instanceof StructuredAcpFailureError) return error.failure;
  const requestError = asRequestError(error);
  if (requestError) {
    return {
      kind: requestError.code === AUTH_REQUIRED_CODE
        ? "authentication_required"
        : requestError.code === REQUEST_CANCELLED_CODE
          ? "cancelled"
          : requestError.code === RESOURCE_NOT_FOUND_CODE
            ? "resource_not_found"
            : "agent_internal_error",
      message: requestError.message,
      protocol_code: requestError.code,
      data: requestError.data ?? null,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const kind: AcpFailureKind = message.startsWith("ACP protocol mismatch:")
    ? "protocol_incompatible"
    : message.startsWith("ACP agent command not found:") || message.startsWith("Failed to start ACP agent command")
      ? "process_start_failed"
      : message.startsWith("ACP readiness probe timed out")
        ? "timeout"
        : "agent_internal_error";
  return { kind, message, protocol_code: null, data: null };
}

export function isAcpAuthRequired(error: unknown): boolean {
  const requestError = asRequestError(error);
  return requestError?.code === AUTH_REQUIRED_CODE;
}

function asRequestError(error: unknown): { code: number; message: string; data?: unknown } | null {
  if (error instanceof RequestError) return error;
  if (error === null || typeof error !== "object") return null;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; data?: unknown };
  if (candidate.name !== "RequestError" || typeof candidate.code !== "number" || typeof candidate.message !== "string") return null;
  return { code: candidate.code, message: candidate.message, data: candidate.data };
}

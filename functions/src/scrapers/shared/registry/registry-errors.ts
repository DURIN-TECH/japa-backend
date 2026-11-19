// ============================================
// SOURCE REGISTRY — ERRORS (issue #215)
// ============================================
//
// One error type for every refusal the registry services make on purpose. The
// controller turns it into `{ success:false, error: code, message, ...extra }`
// with the given HTTP status; the message is plain words an admin can act on.
// Anything that is NOT a RegistryError is an unexpected failure (500).

export class RegistryError extends Error {
  constructor(
    // Stable machine code, e.g. "HOST_NOT_CONFIRMED".
    readonly code: string,
    // HTTP status the controller answers with.
    readonly status: number,
    message: string,
    // Extra fields echoed in the response body (e.g. the list of hosts).
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/** True for a RegistryError. */
export function isRegistryError(err: unknown): err is RegistryError {
  return err instanceof RegistryError;
}

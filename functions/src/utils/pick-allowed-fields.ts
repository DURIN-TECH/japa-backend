// ============================================
// pickAllowedFields — copy only allow-listed keys from client input (#135)
// ============================================
//
// Profile endpoints receive a request body from the client and write it with
// the Admin SDK, which bypasses firestore.rules. Spreading that body into an
// update would let a caller set ANY field on the document, including the ones
// the backend treats as authority (admin flag, agency membership,
// verification state). Every such write goes through this helper with an
// explicit allow-list instead; see USER_SELF_EDITABLE_FIELDS
// (services/user.service.ts) and AGENT_SELF_EDITABLE_FIELDS
// (services/agent.service.ts).

/**
 * Copy only the allow-listed keys of `input` that are actually present
 * (`undefined` is skipped). Shared by the user and agent profile updates so a
 * client-supplied body can never carry extra fields onto a document.
 */
export function pickAllowedFields(
  input: unknown,
  allowed: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // A non-object body (null, a string, an array) has no fields to copy.
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const source = input as Record<string, unknown>;
  for (const key of allowed) {
    // Own properties only: never read through the prototype chain.
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}
